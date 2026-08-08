FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY *.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/o24-deploy-agent .

FROM docker:28-cli
RUN apk add --no-cache ca-certificates tzdata docker-cli-compose
COPY --from=build /out/o24-deploy-agent /usr/local/bin/o24-deploy-agent
USER root
EXPOSE 9100
ENTRYPOINT ["/usr/local/bin/o24-deploy-agent"]
