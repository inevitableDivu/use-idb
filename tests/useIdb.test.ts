import { renderHook, act } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { useIdb } from "../src";

describe("useIdb", () => {
  it("initializes with default value", () => {
    const { result } = renderHook(() => useIdb("test-key", { defaultValue: "initial" }));

    expect(result.current.value).toBe("initial");
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("updates value with setValue", async () => {
    const { result } = renderHook(() => useIdb<string>("test-key", { defaultValue: "initial" }));

    await act(async () => {
      await result.current.setValue("updated");
    });

    expect(result.current.value).toBe("updated");
  });
});
