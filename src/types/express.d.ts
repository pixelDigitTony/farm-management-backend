import type { Types } from "mongoose";

declare global {
  namespace Express {
    interface Request {
      owner?: {
        userId: Types.ObjectId;
        businessId: Types.ObjectId;
        sessionId: Types.ObjectId;
        role: number;
        status: string;
        isApproved: boolean;
        emailVerified: boolean;
      };
    }
  }
}
