ARG GO_IMAGE=golang:1.27.3-bookworm
FROM ${GO_IMAGE} AS builder
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY main.go ./
COPY internal ./internal
COPY LICENSE ./LICENSE
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/pulse-im .

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates ffmpeg && rm -rf /var/lib/apt/lists/* && mkdir -p /data/media /data/runtime/cache /data/runtime/logs && chown -R 65532:65532 /data
COPY --from=builder /out/pulse-im /pulse-im
COPY --from=builder /src/LICENSE /licenses/LICENSE
ENV PULSE_MEDIA_DIR=/data/media PULSE_RUNTIME_DIR=/data/runtime PULSE_FFPROBE=/usr/bin/ffprobe
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/pulse-im"]
CMD ["serve"]
