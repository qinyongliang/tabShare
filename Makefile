.PHONY: build test run
build:
	go build -o bin/tabshare ./cmd/tabshare
test:
	go test -race ./...
	node --test tests/controller.test.mjs
run:
	go run ./cmd/tabshare
