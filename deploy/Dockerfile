FROM golang:1.27.2-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -o /tabshare ./cmd/tabshare

FROM alpine:3.23
RUN addgroup -S tabshare && adduser -S -G tabshare tabshare && mkdir /data && chown tabshare:tabshare /data
COPY --from=build /tabshare /usr/local/bin/tabshare
USER tabshare
EXPOSE 8080
ENTRYPOINT ["tabshare", "-listen", "0.0.0.0:8080", "-data", "/data"]
