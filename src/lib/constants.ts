export const BUSINESS_UNITS = ["PIGGERY", "KARENDERIYA", "GENERAL"] as const;
export const MONEY = { type: "Decimal128", default: 0 } as const;

export const attachmentDefinition = {
  fileName: { type: String, required: true },
  fileUrl: { type: String, required: true },
  mimeType: { type: String, required: true },
  uploadedAt: { type: Date, default: Date.now },
};
