import { useForm } from "react-hook-form";
import { z } from "zod";

/** Phase 1 smoke imports — these libraries are wired up in later phases. */
export const smokeSchema = z.object({ placeholder: z.string() });
export const smokeFormHook = useForm;

void smokeSchema.parse({ placeholder: "ok" });
void smokeFormHook;
