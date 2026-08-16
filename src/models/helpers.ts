import mongoose, { type Model } from "mongoose";

const { Schema } = mongoose;

export const schemaOptions = {
  timestamps: true,
  versionKey: false,
  toJSON: {
    transform: (_doc: unknown, ret: Record<string, unknown>) => {
      ret.id = ret._id?.toString();
      delete ret._id;
      return ret;
    },
  },
} as const;

export const money = { type: Schema.Types.Decimal128, default: 0 };
export const optionalMoney = { type: Schema.Types.Decimal128, default: null };
export const objectId = (ref?: string, required = false) => ({
  type: Schema.Types.ObjectId,
  ...(ref ? { ref } : {}),
  required,
});

export function createModel(name: string, schema: mongoose.Schema): Model<any> {
  return (mongoose.models[name] ?? mongoose.model(name, schema)) as unknown as Model<any>;
}
