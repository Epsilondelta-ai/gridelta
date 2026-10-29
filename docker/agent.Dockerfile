ARG BASE=debian:trixie-slim

FROM golang:1.27 AS build
WORKDIR /src
COPY agent/go.mod agent/go.sum ./
RUN go mod download
COPY agent .
RUN CGO_ENABLED=0 go build -o /out/gridelta-agent ./cmd/gridelta-agent

FROM ${BASE}
COPY --from=build /out/gridelta-agent /usr/local/bin/gridelta-agent
ENTRYPOINT ["gridelta-agent"]
