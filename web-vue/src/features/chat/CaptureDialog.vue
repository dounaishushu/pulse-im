<script setup lang="ts">
import {
  nextTick,
  onMounted,
  onScopeDispose,
  shallowRef,
  useTemplateRef,
} from "vue";
import BaseDialog from "../../components/BaseDialog.vue";
import "../../../../web/voice-format.js";
declare global {
  interface Window {
    PulseVoiceFormat: { prepare(blob: Blob): Promise<{ blob: Blob }> };
  }
}
const props = defineProps<{ mode: "camera" | "voice" | "screen" }>();
const emit = defineEmits<{ close: []; file: [file: File] }>();
const video = useTemplateRef<HTMLVideoElement>("video");
const source = shallowRef(""),
  devices = shallowRef<MediaDeviceInfo[]>([]),
  chosen = shallowRef(localStorage.getItem("pulse_video_input") || "");
const error = shallowRef(""),
  recording = shallowRef(false),
  busy = shallowRef(false),
  seconds = shallowRef(0);
let stream: MediaStream | undefined,
  recorder: MediaRecorder | undefined,
  blob: Blob | undefined;
let audioContext: AudioContext | undefined;
let alive = true,
  epoch = 0,
  timer: ReturnType<typeof setInterval> | undefined;
function cleanup() {
  clearInterval(timer);
  timer = undefined;
  if (recorder) {
    recorder.onstop = null;
    recorder.ondataavailable = null;
    if (recorder.state !== "inactive") recorder.stop();
  }
  void audioContext?.close();
  audioContext = undefined;
  recorder = undefined;
  stream?.getTracks().forEach((track) => track.stop());
  stream = undefined;
  if (video.value) {
    video.value.pause();
    video.value.srcObject = null;
  }
  if (source.value) URL.revokeObjectURL(source.value);
  source.value = "";
  blob = undefined;
  recording.value = false;
}
function stop() {
  if (recorder?.state === "recording") recorder.stop();
}
async function start() {
  const mine = ++epoch;
  cleanup();
  busy.value = true;
  error.value = "";
  seconds.value = 0;
  const current = () => alive && mine === epoch;
  try {
    if (!navigator.mediaDevices)
      throw Error("当前浏览器无法访问设备，请使用 HTTPS 或上传附件。");
    const audioId = localStorage.getItem("pulse_audio_input") || "default";
    const acquired =
      props.mode === "voice"
        ? await navigator.mediaDevices.getUserMedia({
            audio:
              audioId === "default" ? true : { deviceId: { exact: audioId } },
          })
        : props.mode === "screen"
          ? await navigator.mediaDevices.getDisplayMedia({
              video: true,
              audio: false,
            })
          : await navigator.mediaDevices.getUserMedia({
              video: chosen.value
                ? { deviceId: { exact: chosen.value } }
                : true,
              audio: false,
            });
    if (!current()) {
      acquired.getTracks().forEach((track) => track.stop());
      return;
    }
    stream = acquired;
    if (props.mode === "voice") {
      let recordStream = acquired;
      const volume = Math.max(
        0,
        Math.min(
          100,
          Number(localStorage.getItem("pulse_input_volume") ?? 100),
        ),
      );
      if (volume < 100) {
        const context = new AudioContext();
        audioContext = context;
        await context.resume();
        if (!current()) {
          void context.close();
          return;
        }
        const gain = context.createGain(),
          destination = context.createMediaStreamDestination();
        gain.gain.value = volume / 100;
        context
          .createMediaStreamSource(acquired)
          .connect(gain)
          .connect(destination);
        recordStream = destination.stream;
      }
      const mime = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/ogg;codecs=opus",
        "audio/mp4",
      ].find((type) => MediaRecorder.isTypeSupported(type));
      if (!mime) throw Error("当前浏览器不支持语音录制格式");
      const rec = new MediaRecorder(recordStream, { mimeType: mime }),
        chunks: Blob[] = [];
      recorder = rec;
      rec.ondataavailable = (event) => {
        if (current() && event.data.size) chunks.push(event.data);
      };
      rec.onstop = () => {
        clearInterval(timer);
        timer = undefined;
        acquired.getTracks().forEach((track) => track.stop());
        void audioContext?.close();
        audioContext = undefined;
        if (!current()) return;
        blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
        if (source.value) URL.revokeObjectURL(source.value);
        source.value = URL.createObjectURL(blob);
        recording.value = false;
      };
      rec.start();
      recording.value = true;
      timer = setInterval(() => {
        if (++seconds.value >= 300) stop();
      }, 1000);
    } else {
      await nextTick();
      if (!current()) return;
      if (video.value) {
        video.value.srcObject = acquired;
        await video.value.play();
      }
      if (props.mode === "camera") {
        const values = await navigator.mediaDevices.enumerateDevices();
        if (current())
          devices.value = values.filter(
            (device) => device.kind === "videoinput",
          );
      }
    }
  } catch (cause) {
    if (current()) {
      cleanup();
      error.value =
        cause instanceof Error
          ? cause.message
          : "无法打开设备，请检查浏览器权限";
    }
  } finally {
    if (current()) busy.value = false;
  }
}
async function capture() {
  if (busy.value || recording.value) return;
  const mine = epoch;
  busy.value = true;
  try {
    let file: File;
    if (props.mode === "voice") {
      if (!blob?.size) throw Error("请先完成录音");
      const compatible = await window.PulseVoiceFormat.prepare(blob);
      file = new File([compatible.blob], "语音-" + Date.now() + ".wav", {
        type: "audio/wav",
      });
    } else {
      const element = video.value;
      if (!element?.videoWidth) throw Error("画面尚未就绪");
      const canvas = document.createElement("canvas"),
        ratio = Math.min(
          1,
          4096 / Math.max(element.videoWidth, element.videoHeight),
        );
      canvas.width = Math.max(1, Math.round(element.videoWidth * ratio));
      canvas.height = Math.max(1, Math.round(element.videoHeight * ratio));
      canvas
        .getContext("2d")!
        .drawImage(element, 0, 0, canvas.width, canvas.height);
      const png = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/png"),
      );
      if (!png) throw Error("无法保存图片");
      file = new File(
        [png],
        props.mode === "camera" ? "拍照.png" : "截图.png",
        { type: "image/png" },
      );
    }
    if (alive && mine === epoch) {
      emit("file", file);
      emit("close");
    }
  } catch (cause) {
    if (alive && mine === epoch)
      error.value = cause instanceof Error ? cause.message : "处理失败";
  } finally {
    if (alive && mine === epoch) busy.value = false;
  }
}
function changeCamera() {
  localStorage.setItem("pulse_video_input", chosen.value);
  void start();
}
onMounted(() => {
  void start();
});
onScopeDispose(() => {
  alive = false;
  ++epoch;
  cleanup();
});
</script>
<template>
  <BaseDialog
    :title="
      mode === 'camera'
        ? '拍照发送'
        : mode === 'voice'
          ? '录制语音'
          : '截图发送'
    "
    @close="emit('close')"
  >
    <p v-if="error" role="alert">{{ error }}</p>
    <template v-if="mode === 'voice'">
      <p v-if="recording" role="status">
        正在录音 {{ seconds }} 秒（最多 5 分钟）
      </p>
      <audio v-if="source" :src="source" controls></audio>
      <button v-if="recording" @click="stop">停止录音</button>
    </template>
    <template v-else>
      <select
        v-if="mode === 'camera'"
        v-model="chosen"
        :disabled="busy"
        aria-label="选择摄像头"
        @change="changeCamera"
      >
        <option value="">默认摄像头</option>
        <option
          v-for="device in devices"
          :key="device.deviceId"
          :value="device.deviceId"
        >
          {{ device.label || "摄像头" }}
        </option>
      </select>
      <video
        ref="video"
        autoplay
        muted
        playsinline
        style="width: 100%; max-height: 50vh"
      ></video>
    </template>
    <footer>
      <button :disabled="busy" @click="start">重新检测</button
      ><button class="primary" :disabled="busy || recording" @click="capture">
        {{ mode === "voice" ? "使用录音" : "使用图片" }}
      </button>
    </footer>
  </BaseDialog>
</template>
