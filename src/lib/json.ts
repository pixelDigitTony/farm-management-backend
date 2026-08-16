type Decimal128Json = { $numberDecimal: string };

function isDecimal128Json(value: unknown): value is Decimal128Json {
  return (
    typeof value === "object" &&
    value !== null &&
    "$numberDecimal" in value &&
    typeof value.$numberDecimal === "string"
  );
}

export function mongoJsonReplacer(_key: string, value: unknown) {
  return isDecimal128Json(value) ? value.$numberDecimal : value;
}
