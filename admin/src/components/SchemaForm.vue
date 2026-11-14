<script setup lang="ts">
import { useTemplateRef } from "vue";
import type { FormInstance } from "element-plus";
import type { FormField, RecordData } from "../domain/types";
import ImageUpload from "./ImageUpload.vue";
defineProps<{
  fields: FormField[];
  modelValue: RecordData;
  disabled?: boolean;
}>();
const emit = defineEmits<{
  "update:modelValue": [value: RecordData];
  busy: [value: boolean];
}>();
const form = useTemplateRef<FormInstance>("form");
function update(model: RecordData, key: string, value: unknown) {
  emit("update:modelValue", { ...model, [key]: value });
}
async function validate() {
  return (await form.value?.validate().catch(() => false)) ?? false;
}
defineExpose({ validate });
</script>
<template>
  <el-form
    ref="form"
    :model="modelValue"
    label-position="top"
    :disabled="disabled"
    class="schema-form"
    @submit.prevent
  >
    <el-form-item
      v-for="field in fields"
      :key="`${field.key}-${field.type || 'text'}`"
      :label="field.label"
      :prop="field.key"
      :class="{ 'form-wide': field.wide || field.type === 'textarea' }"
      :rules="
        field.required
          ? [
              {
                required: true,
                message: `请填写${field.label}`,
                trigger: ['blur', 'change'],
              },
            ]
          : []
      "
    >
      <el-select
        :aria-label="field.label"
        v-if="field.type === 'select'"
        :model-value="modelValue[field.key]"
        :disabled="field.disabled"
        @update:model-value="update(modelValue, field.key, $event)"
        ><el-option
          v-for="option in field.options"
          :key="String(option.value)"
          :value="option.value"
          :label="option.label"
      /></el-select>
      <el-switch
        :aria-label="field.label"
        v-else-if="field.type === 'switch'"
        :model-value="!!modelValue[field.key]"
        :disabled="field.disabled"
        @update:model-value="update(modelValue, field.key, $event)"
      />
      <el-input-number
        :aria-label="field.label"
        v-else-if="field.type === 'number'"
        :model-value="Number(modelValue[field.key] || 0)"
        :min="field.min"
        :max="field.max"
        :step="field.step || 1"
        :disabled="field.disabled"
        controls-position="right"
        @update:model-value="update(modelValue, field.key, $event)"
      />
      <el-time-picker
        :aria-label="field.label"
        v-else-if="field.type === 'time'"
        :model-value="modelValue[field.key]"
        value-format="HH:mm"
        format="HH:mm"
        :disabled="field.disabled"
        @update:model-value="update(modelValue, field.key, $event)"
      />
      <el-date-picker
        :aria-label="field.label"
        v-else-if="field.type === 'date' || field.type === 'datetime'"
        :type="field.type"
        :model-value="modelValue[field.key]"
        :value-format="
          field.type === 'date' ? 'YYYY-MM-DD' : 'YYYY-MM-DDTHH:mm:ss'
        "
        :disabled="field.disabled"
        @update:model-value="update(modelValue, field.key, $event)"
      />
      <ImageUpload
        v-else-if="field.type === 'image'"
        :model-value="modelValue[field.key] || ''"
        path="/admin/work-questions/upload"
        :disabled="disabled || field.disabled"
        @update:model-value="update(modelValue, field.key, $event)"
        @busy="emit('busy', $event)"
      />
      <el-input
        :aria-label="field.label"
        v-else
        :model-value="modelValue[field.key]"
        :type="
          field.type === 'textarea'
            ? 'textarea'
            : field.type === 'password'
              ? 'password'
              : 'text'
        "
        :rows="field.type === 'textarea' ? 4 : undefined"
        :show-password="field.type === 'password'"
        :maxlength="field.maxLength"
        :show-word-limit="!!field.maxLength && field.type === 'textarea'"
        :disabled="field.disabled"
        :autocomplete="field.type === 'password' ? 'new-password' : 'off'"
        @update:model-value="update(modelValue, field.key, $event)"
      />
      <p v-if="field.help" class="field-help">{{ field.help }}</p>
    </el-form-item>
  </el-form>
</template>
