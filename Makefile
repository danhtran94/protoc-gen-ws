.PHONY: test test-go test-ts test-example-ts test-all gen-example install build-ts release

test: test-go test-ts

test-go:
	go test ./ws/ -race -count=1

test-ts:
	cd ts && npm test

test-example-ts: gen-example
	cd example/ts && npm test

test-all: test test-example-ts

build-ts:
	cd ts && npm run build

gen-example:
	cd example && buf generate

install:
	go install ./cmd/protoc-gen-ws/
	go install ./cmd/protoc-gen-ws-ts/

release:
	@./scripts/release.sh
