import { z } from "zod";

export const approvalDecisionSchema = z.object({
  decision: z.enum(["approve", "reject"], {
    errorMap: () => ({ message: "decision must be approve or reject" }),
  }),
});

export const approvalIdParamSchema = z.string().uuid();

export type ApprovalDecisionBody = z.infer<typeof approvalDecisionSchema>;

export function fieldErrors(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_root";
    if (!fields[key]) {
      fields[key] = issue.message;
    }
  }
  return fields;
}
