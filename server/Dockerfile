ARG GO_IMAGE=golang:1.27.3-bookworm
FROM ${GO_IMAGE} AS builder
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY main.go ./
COPY internal ./internal
COPY LICENSE ./LICENSE
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/pulse-im .

FROM scratch
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=builder /out/pulse-im /pulse-im
COPY --from=builder /src/LICENSE /licenses/LICENSE
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/pulse-im"]
CMD ["serve"]
