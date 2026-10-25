// From the front end's packages/core/src/corrections.ts (25 Oct 2026): the fields a parent can ask
// the school to correct, and their labels. Its Zod rules (checkCorrection, correctionRequestSchema,
// declineSchema) live in apps/api/src/routes/corrections.ts with the same rules, since this
// package has no dependencies. Keep both in step with the front end.

export const CORRECTABLE = ["firstName", "otherNames", "lastName", "dateOfBirth", "gender", "stateOfOrigin", "address", "guardianPhone", "guardianEmail"] as const;
export type CorrectableField = (typeof CORRECTABLE)[number];

export const CORRECTION_LABEL: Record<CorrectableField, string> = {
  firstName: "First name",
  otherNames: "Other names",
  lastName: "Last name",
  dateOfBirth: "Date of birth",
  gender: "Gender",
  stateOfOrigin: "State of origin",
  address: "Home address",
  guardianPhone: "Your phone number",
  guardianEmail: "Your email",
};

/** The same fields as the school sees them. */
export const CORRECTION_LABEL_FOR_SCHOOL: Record<CorrectableField, string> = {
  ...CORRECTION_LABEL,
  guardianPhone: "Guardian’s phone number",
  guardianEmail: "Guardian’s email",
};
