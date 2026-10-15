import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { markdownSchema } from "../../src/markdown/schema";
import { parseMarkdown } from "../../src/markdown/parser";
import { ReadView } from "../../src/main/components/ReadView";
import { SourceEditor } from "../../src/main/components/SourceEditor";
import { StatusBar } from "../../src/main/components/StatusBar";
import { useDocumentStore } from "../../src/main/state/documentStore";

vi.mock("../../src/markdown/parser", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/markdown/parser")>();
  return {
    parseMarkdown: vi.fn((source: string) => {
      if (source.includes("__PARSE_FAILURE__")) {
        throw new Error("invalid markdown");
      }
      return actual.parseMarkdown(source);
    }),
  };
});

describe("editor modes", () => {
  beforeEach(() => {
    vi.mocked(parseMarkdown).mockClear();
    useDocumentStore.setState({
      filePath: null,
      fileName: "未命名.md",
      doc: parseMarkdown(""),
      dirty: false,
      mode: "wysiwyg",
      sessionKey: "session-0",
      sessionGeneration: 0,
      sourceText: "",
      sourceParseError: null,
      themePreference: "system",
    });
  });

  it("serializes WYSIWYG content into an isolated source session", () => {
    useDocumentStore.getState().replaceDocument({
      doc: parseMarkdown("# Title\n\n<!-- protected -->\n"),
      filePath: null,
      fileName: "demo.md",
      dirty: false,
    });

    useDocumentStore.getState().transitionMode("source");

    const state = useDocumentStore.getState();
    expect(state.mode).toBe("source");
    expect(state.sourceText).toBe("# Title\n\n<!-- protected -->\n");
    expect(state.sourceParseError).toBeNull();
    expect(state.dirty).toBe(false);
    expect(state.sessionKey).toBe("session-1");
  });

  it("parses edited source back into the model without losing raw blocks", () => {
    useDocumentStore.getState().replaceDocument({
      doc: parseMarkdown("# Before\n"),
      filePath: null,
      fileName: "demo.md",
      dirty: false,
    });
    useDocumentStore.getState().transitionMode("source");
    useDocumentStore.getState().setSourceText("# After\n\n<!-- protected -->\n");

    useDocumentStore.getState().transitionMode("wysiwyg");

    const state = useDocumentStore.getState();
    expect(state.mode).toBe("wysiwyg");
    expect(state.doc.child(0).textContent).toBe("After");
    expect(state.doc.child(1).type).toBe(markdownSchema.nodes.raw_block);
    expect(state.doc.child(1).attrs.source).toBe("<!-- protected -->");
    expect(state.sourceText).toBe("# After\n\n<!-- protected -->\n");
    expect(state.dirty).toBe(true);
    expect(state.sourceParseError).toBeNull();
  });

  it("updates the read model from source while preserving dirty state", () => {
    useDocumentStore.getState().replaceDocument({
      doc: parseMarkdown("# Before\n"),
      filePath: null,
      fileName: "demo.md",
      dirty: false,
    });
    useDocumentStore.getState().transitionMode("source");
    useDocumentStore.getState().setSourceText("# For reading\n");

    useDocumentStore.getState().transitionMode("read");

    const state = useDocumentStore.getState();
    expect(state.mode).toBe("read");
    expect(state.doc.textContent).toBe("For reading");
    expect(state.dirty).toBe(true);
    expect(state.sourceParseError).toBeNull();
  });

  it("keeps source content and reports an error when parsing fails", () => {
    useDocumentStore.getState().replaceDocument({
      doc: parseMarkdown("# Stable model\n"),
      filePath: null,
      fileName: "demo.md",
      dirty: false,
    });
    useDocumentStore.getState().transitionMode("source");
    const staleDoc = useDocumentStore.getState().doc;
    useDocumentStore.getState().setSourceText("__PARSE_FAILURE__");

    useDocumentStore.getState().transitionMode("wysiwyg");

    const failed = useDocumentStore.getState();
    expect(failed.mode).toBe("source");
    expect(failed.sourceText).toBe("__PARSE_FAILURE__");
    expect(failed.doc).toBe(staleDoc);
    expect(failed.sourceParseError).toBe("Markdown 解析失败");
    expect(failed.dirty).toBe(true);

    useDocumentStore.getState().setSourceText("# Recovered\n");
    useDocumentStore.getState().transitionMode("wysiwyg");
    expect(useDocumentStore.getState().doc.textContent).toBe("Recovered");
    expect(useDocumentStore.getState().sourceParseError).toBeNull();
  });

  it("stores the theme preference", () => {
    expect(useDocumentStore.getState().themePreference).toBe("system");

    useDocumentStore.getState().setThemePreference("dark");

    expect(useDocumentStore.getState().themePreference).toBe("dark");
  });

  it("exposes non-editing mode surfaces for later E2E checks", () => {
    const source = renderToStaticMarkup(
      createElement(SourceEditor, {
        initialValue: "# Source\n",
        sessionKey: "session-1",
        onChange: () => undefined,
      }),
    );
    expect(source).toContain('data-testid="source-editor"');
    expect(source).toContain('data-session-key="session-1"');

    const read = renderToStaticMarkup(
      createElement(ReadView, { doc: parseMarkdown("# Read\n") }),
    );
    expect(read).toContain('data-testid="read-view"');
    expect(read).toContain('contenteditable="false"');
    expect(read).toContain('aria-readonly="true"');

    const status = renderToStaticMarkup(
      createElement(StatusBar, {
        fileName: "demo.md",
        dirty: true,
        mode: "source",
      }),
    );
    expect(status).toContain('data-testid="status-bar"');
    expect(status).toContain("demo.md");
    expect(status).toContain("未保存");
    expect(status).toContain("源码");
  });
});
