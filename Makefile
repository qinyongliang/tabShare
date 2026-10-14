.PHONY: build test run
build:
	go build -o bin/tabshare ./cmd/tabshare
test:
	go test -race ./...
	npm test
run:
	go run ./cmd/tabshare
