import { EventEmitter } from "node:events";
import type { NextFunction, Request, Response } from "express";
import mongoose from "mongoose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { auditOwnerInteraction } from "../src/middleware/activity-audit.js";
import { AuditLog } from "../src/models/index.js";

function runAuditedRequest(
  status: number,
  responseBody: Record<string, unknown>,
  requestBody: object,
) {
  const userId = new mongoose.Types.ObjectId();
  const businessId = new mongoose.Types.ObjectId();
  const request = {
    method: "POST",
    originalUrl: "/api/future-feature/records",
    path: "/future-feature/records",
    body: requestBody,
    ip: "127.0.0.1",
    get: vi.fn(() => "test-agent"),
  } as unknown as Request;
  const response = new EventEmitter() as EventEmitter & Response;
  response.statusCode = status;
  response.json = vi.fn(() => response) as Response["json"];
  const next = vi.fn(() => {
    request.owner = {
      userId,
      businessId,
      sessionId: new mongoose.Types.ObjectId(),
      role: 0,
      status: "ACTIVE",
      isApproved: true,
      emailVerified: true,
    };
    response.json(responseBody);
    response.emit("finish");
  }) as unknown as NextFunction;

  auditOwnerInteraction(request, response, next);
  return { userId, businessId };
}

describe("automatic owner activity audit", () => {
  afterEach(() => vi.restoreAllMocks());

  it("records successful mutations on future protected routes", async () => {
    const create = vi.spyOn(AuditLog, "create").mockResolvedValue({} as never);
    const { userId, businessId } = runAuditedRequest(201, { saved: true }, { name: "Sample" });

    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId,
        businessId,
        action: "POST",
        targetCollection: "future-feature/records",
        requestMethod: "POST",
        requestPath: "/api/future-feature/records",
        responseStatus: 201,
        outcome: "SUCCESS",
        changedFields: ["name"],
      }),
    );
  });

  it("records failed mutations and their safe response message", async () => {
    const create = vi.spyOn(AuditLog, "create").mockResolvedValue({} as never);
    runAuditedRequest(422, { message: "The record could not be saved" }, { amount: -1 });

    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "FAILED",
        responseStatus: 422,
        errorMessage: "The record could not be saved",
        changedFields: ["amount"],
      }),
    );
  });
});
