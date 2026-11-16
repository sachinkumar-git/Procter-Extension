import { describe, expect, it } from "vitest";
import { assertSafeApiUrl } from "./api-client";

describe("assertSafeApiUrl", () => {
  it("accepts HTTPS and local development servers", () => {
    expect(() => assertSafeApiUrl("https://exam.example.edu")).not.toThrow();
    expect(() => assertSafeApiUrl("http://localhost:3000")).not.toThrow();
  });

  it("rejects plain HTTP to any other host", () => {
    expect(() => assertSafeApiUrl("http://exam.example.edu")).toThrow("HTTPS");
  });
});
