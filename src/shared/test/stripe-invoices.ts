/**
 * Test stand-in for Stripe's `GET /v1/invoices`, shared by the invoice
 * collector and download-route tests.
 */

/** The invoice fields the application reads, as Stripe's list returns them. */
export type StripeInvoiceFixture = {
  id: string;
  object: "invoice";
  customer: string;
  created: number;
  currency: string;
  total: number;
  number: string | null;
  status: string;
  hosted_invoice_url: string | null;
  invoice_pdf: string | null;
};

export type StripeInvoiceListParams = {
  customer: string;
  limit: number;
  starting_after?: string;
  created?: { gte?: number; lte?: number };
};

export const stripeList = (data: unknown[], has_more: boolean) => ({
  object: "list",
  url: "/v1/invoices",
  has_more,
  data,
});

/** Shape of a stripe-node error, without constructing the SDK. */
export const stripeError = (fields: Record<string, unknown>) =>
  Object.assign(new Error(String(fields.message ?? "stripe error")), fields);

/**
 * `invoices.list` over a store holding several customers' invoices, newest
 * first: filters on `customer` and the `created` range (unless
 * `ignoreCreated`), then honours `limit` and `starting_after` exactly as
 * Stripe's cursor paging does (an unknown `starting_after` is Stripe's 400).
 */
export function stripeInvoiceList(
  store: StripeInvoiceFixture[],
  { ignoreCreated = false } = {},
) {
  return async ({
    customer,
    limit,
    starting_after,
    created,
  }: StripeInvoiceListParams) => {
    const list = store.filter(
      (invoice) =>
        invoice.customer === customer &&
        (ignoreCreated ||
          ((created?.gte === undefined || invoice.created >= created.gte) &&
            (created?.lte === undefined || invoice.created <= created.lte))),
    );
    const start =
      starting_after === undefined
        ? 0
        : list.findIndex((invoice) => invoice.id === starting_after) + 1;

    if (start === 0 && starting_after !== undefined) {
      throw stripeError({
        type: "StripeInvalidRequestError",
        code: "resource_missing",
        param: "starting_after",
        statusCode: 400,
        message: `No such invoice: '${starting_after}'`,
      });
    }

    const data = list.slice(start, start + limit);
    return stripeList(data, start + data.length < list.length);
  };
}
