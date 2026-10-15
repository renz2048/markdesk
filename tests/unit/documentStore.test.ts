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
      sessionKey: "session-0",
      sessionGeneration: 0,
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

  it("keeps ordinary edits in the current editing session", () => {
    const before = useDocumentStore.getState();
    const sessionKey = before.sessionKey;
    const generation = before.sessionGeneration;
    useDocumentStore.getState().setDocument(parseMarkdown("# Typed"));

    const after = useDocumentStore.getState();
    expect(after.doc.textContent).toBe("Typed");
    expect(after.dirty).toBe(true);
    expect(after.sessionKey).toBe(sessionKey);
    expect(after.sessionGeneration).toBe(generation);
  });

  it("atomically opens or replaces a document with a new session", () => {
    const doc = parseMarkdown("# Opened");
    useDocumentStore.getState().replaceDocument({
      doc,
      filePath: "/tmp/same.md",
      fileName: "same.md",
      dirty: false,
    });
    const opened = useDocumentStore.getState();
    expect(opened.doc).toBe(doc);
    expect(opened.filePath).toBe("/tmp/same.md");
    expect(opened.fileName).toBe("same.md");
    expect(opened.dirty).toBe(false);
    expect(opened.sessionKey).toBe("session-1");
    expect(opened.sessionGeneration).toBe(1);

    const replacement = parseMarkdown("# Recovered");
    useDocumentStore.getState().replaceDocument({
      doc: replacement,
      filePath: "/tmp/same.md",
      fileName: "same.md",
      dirty: true,
    });
    const recovered = useDocumentStore.getState();
    expect(recovered.doc).toBe(replacement);
    expect(recovered.dirty).toBe(true);
    expect(recovered.sessionKey).toBe("session-2");
    expect(recovered.sessionGeneration).toBe(2);
  });

  it("updates mode, file identity, and saved state", () => {
    useDocumentStore.getState().setMode("source");
    const doc = parseMarkdown("# Demo");
    const before = useDocumentStore.getState();
    useDocumentStore.getState().saveAs("/tmp/demo.md", "demo.md");
    useDocumentStore.getState().setDocument(parseMarkdown("# Demo"));
    useDocumentStore.getState().markSaved();

    const state = useDocumentStore.getState();
    expect(state.mode).toBe("source");
    expect(state.filePath).toBe("/tmp/demo.md");
    expect(state.fileName).toBe("demo.md");
    expect(state.dirty).toBe(false);
    expect(state.sessionKey).toBe(before.sessionKey);
    expect(state.doc).not.toBe(doc);
  });
});
