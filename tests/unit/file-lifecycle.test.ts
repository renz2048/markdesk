import { describe, expect, it } from "vitest";
import {
  FileLifecycleController,
  toFileActionError,
} from "../../src/main/fileLifecycle";

describe("shared file-operation guard and revisions", () => {
  it("blocks a second operation until the first completes", () => {
    const controller = new FileLifecycleController();

    const first = controller.beginOperation();
    expect(first).not.toBeNull();
    const blocked = controller.beginOperation();
    expect(blocked).toBeNull();

    controller.endOperation();
    const second = controller.beginOperation();
    expect(second).not.toBeNull();
    controller.endOperation();
  });

  it("issues distinct revision tokens to successive operations", () => {
    const controller = new FileLifecycleController();
    const saveRevision = controller.beginOperation();
    controller.endOperation();
    const replacementRevision = controller.beginOperation();

    expect(saveRevision).not.toBe(replacementRevision);
    expect(controller.isCurrent(saveRevision)).toBe(false);
    expect(controller.isCurrent(replacementRevision)).toBe(true);
    controller.endOperation();
  });

  it("invalidates a saved revision after document edits", () => {
    const controller = new FileLifecycleController();
    const revision = controller.beginOperation();

    controller.markEdited();

    expect(controller.isCurrent(revision)).toBe(false);
    controller.endOperation();
  });

  it("does not issue a new revision for a blocked operation", () => {
    const controller = new FileLifecycleController();
    const revision = controller.beginOperation();

    expect(controller.beginOperation()).toBeNull();
    expect(controller.currentRevision).toBe(revision);
    controller.endOperation();
  });
});

describe("renderer file error normalization", () => {
  it("preserves typed IPC codes", () => {
    const error = Object.assign(new Error("changed"), {
      code: "file-changed",
    });

    expect(toFileActionError(error)).toMatchObject({
      code: "file-changed",
      message: "文件已被其他程序修改，请重新打开后再保存。",
    });
  });

  it("applies parse and serialize fallback codes to native errors", () => {
    expect(toFileActionError(new Error("bad token"), "parse")).toMatchObject({
      code: "parse",
    });
    expect(
      toFileActionError(new Error("bad node"), "serialize"),
    ).toMatchObject({ code: "serialize" });
  });
});
