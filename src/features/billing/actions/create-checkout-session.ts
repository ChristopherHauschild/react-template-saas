"use server";

import { redirect } from "next/navigation";

import { getCurrentUser } from "@/infrastructure/auth/session/get-current-user";
import { stripe } from "@/infrastructure/stripe";

export async function createCheckoutSession(priceId: string) {
  const user = await getCurrentUser();

  if (!user?.email) {
    throw new Error("User not authenticated");
  }

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    payment_method_types: ["card"],
    customer_email: user.email,
    line_items: [
      {
        price: priceId,
        quantity: 1,
      },
    ],
    success_url: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard`,
    cancel_url: `${process.env.NEXT_PUBLIC_APP_URL}/pricing`,
    metadata: { userId: user.id },
  });

  redirect(session.url!);
}
