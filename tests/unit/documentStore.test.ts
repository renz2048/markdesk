import { beforeEach, describe, expect, it } from "vitest";
import { parseMarkdown } from "../../src/markdown/parser";
import { useDocumentStore } from "../../src/main/state/documentStore";

describe("document store", () => {
  beforeEach(() => {
    useDocumentStore.setState({
      filePath: null,
      fileName: "未命名.md",
      doc: parseMarkdown(""),
      dirty: false,
      mode: "wysiwyg",
    });
  });

  it("marks replaced documents dirty by default", () => {
    const doc = parseMarkdown("# Changed");
    useDocumentStore.getState().setDocument(doc);
    expect(useDocumentStore.getState().doc).toBe(doc);
    expect(useDocumentStore.getState().dirty).toBe(true);
  });

  it("supports clean document replacement", () => {
    const doc = parseMarkdown("# Loaded");
    useDocumentStore.getState().setDocument(doc, false);
    expect(useDocumentStore.getState().doc).toBe(doc);
    expect(useDocumentStore.getState().dirty).toBe(false);
  });

  it("updates mode, file identity, and saved state", () => {
    useDocumentStore.getState().setMode("source");
    useDocumentStore.getState().setFile("/tmp/demo.md", "demo.md");
    useDocumentStore.getState().setDocument(parseMarkdown("# Demo"));
    useDocumentStore.getState().markSaved();

    const state = useDocumentStore.getState();
    expect(state.mode).toBe("source");
    expect(state.filePath).toBe("/tmp/demo.md");
    expect(state.fileName).toBe("demo.md");
    expect(state.dirty).toBe(false);
  });
});
