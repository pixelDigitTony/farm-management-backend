import type { NextFunction, Request, Response } from "express";
import mongoose from "mongoose";
import { ValiError } from "valibot";
import { DomainValidationError } from "../lib/domain-error.js";
import { HttpError } from "../lib/http-error.js";

export function notFound(request: Request, _response: Response, next: NextFunction) {
  next(new HttpError(404, `Route ${request.method} ${request.path} was not found`));
}

export function errorHandler(
  error: unknown,
  _request: Request,
  response: Response,
  _next: NextFunction,
) {
  if (error instanceof DomainValidationError)
    return response.status(422).json({ message: error.message });
  if (error instanceof mongoose.Error.CastError)
    return response.status(422).json({ message: "Invalid record field or identifier" });
  if (error instanceof ValiError) {
    return response.status(422).json({ message: "Validation failed", issues: error.issues });
  }
  if (error instanceof HttpError) {
    return response
      .status(error.status)
      .json({ message: error.message, code: error.code, details: error.details });
  }
  if (error instanceof mongoose.Error.ValidationError) {
    return response.status(422).json({ message: error.message });
  }
  if ((error as { code?: number }).code === 11000) {
    return response
      .status(409)
      .json({ message: "A record with the same unique value already exists" });
  }
  console.error(error);
  return response.status(500).json({ message: "An unexpected server error occurred" });
}
