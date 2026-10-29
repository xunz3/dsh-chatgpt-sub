# Native file inputs

Attach a PDF, document, spreadsheet, or text/code file in Harness. Supported user attachments are sent as Responses `input_file` parts with inline Base64 data, including on later turns that retain the original attachment. PDF page images require a vision-capable model. Unknown formats and PDFs on explicitly text-only models keep Harness's normal file-tool handle.

Native input is enabled by default; set `nativeFiles: false` in the plugin configuration to keep all files on the file-tool route. On DSH 0.2.1, a mixed message whose image blocks are projected for a text-only model also keeps its file-tool representation, because the bridge only restores intact, exactly matched messages.

Common supported formats: PDF; DOC/DOCX/ODT/RTF; PPT/PPTX; XLS/XLSX/CSV/TSV; Markdown, JSON, HTML, XML, and common source-code/text formats. Archives and executables are not sent natively. Non-PDF documents generally contribute extracted text, so convert visual documents to PDF when their layout or charts matter. Model and account policy can still reject a supported format.

The plugin caps file payloads at **20 MiB after Base64 encoding per request**, counting repeated history occurrences. Split large documents or start a fresh conversation when that limit is reached. This local transport bound is separate from plan quotas and model context limits. Harness's context meter does not yet estimate native file contents; a dense document may hit the model's context limit even when the local byte limit passes.

## Host integration

DSH 0.2.1 converts durable file blocks to path descriptions before dispatching an adapter. The plugin uses its public `llm/stream` waterfall to carry typed user file references in a request-local async scope. It restores an occurrence only when message identity/order, untouched content, and the exact host-generated file description still match. Other providers and durable history remain unchanged; arbitrary path text is never interpreted as an attachment.

This is a compatibility bridge, not a public attachment seam: it depends on the host projecting files after `llm/stream`. If captured files cannot be restored and no user file blocks remain, the bridge logs one warning through the plugin logger and leaves the host's file-handle text in place. If a future Harness projects files before this waterfall, there are no file blocks to capture or detect, so the host's file-handle text passes through without a warning. The bridge never throws or blocks a request, and `nativeFiles: false` is the explicit opt-out.

Bytes are read only through `AttachmentStore.readFileStream`, with cancellation and complete integrity verification before transmission. Reads are bounded, sequential, and deduplicated within one call. No Files upload API, external file fetch, global host patch, or arbitrary filesystem reads are used. File-reader failures produce a generic reattach message without revealing host paths. Tool-result files retain their normal file-tool representation.

## Validation

`pnpm test` covers inline encoding, duplicate occurrences, actual byte verification, unsupported-format fallback, cancellation, concurrent/nested scope isolation, cleanup, forged-text rejection, the one-time degradation warning, and integration with the real Harness LLM waterfall.

Official references: [Responses file inputs](https://developers.openai.com/api/docs/guides/file-inputs), [Sign in with ChatGPT limits](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).
