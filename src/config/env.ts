import { clientEnv } from "./env.client";
import { serverEnv } from "./env.server";

export const env = { ...clientEnv, ...serverEnv };
