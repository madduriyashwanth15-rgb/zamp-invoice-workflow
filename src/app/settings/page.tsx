import { paiseToRupees } from "@/domain/money";
import { loadReferenceData } from "@/fixtures/load";
import { formatDate, formatInr } from "@/lib/format";
import { withDemoSenders } from "@/server/runtime";

// Spec 8: the settings and reference data every check uses, shown read-only.

export default function SettingsPage() {
  const ref = withDemoSenders(loadReferenceData());
  const s = ref.settings;
  const rules: [string, string][] = [
    ["Price tolerance (C1, C3, M7)", `${s.price_tolerance_pct}% above the PO`],
    ["Quantity tolerance (C2)", `${s.quantity_tolerance_pct}%`],
    ["Rounding tolerance (V2, T3)", `₹${s.rounding_tolerance_inr}`],
    ["Approval limit (C5)", formatInr(String(s.approval_limit_inr)) ?? ""],
    ["AP forwarding addresses (K3)", s.ap_forwarder_allowlist.join(", ")],
    ["Charge keywords (M7)", s.charge_keywords.join(", ")],
    ["Lump-sum markers (M5)", [...s.lump_sum_markers.phrases, ...s.lump_sum_markers.units.map((u) => `unit "${u}"`)].join(", ")],
    ["Buyer", `${s.buyer.name}, GSTIN ${s.buyer.gstin}`],
  ];
  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">Rules and reference data</h1>
        <p className="mt-1 max-w-3xl text-sm text-ink-2">
          What every check compares against. These come from the test-data files (fictional), stand in for the ERP and
          are read-only here: changing a vendor or a PO is done in the source system, not in this tool.
        </p>
      </header>

      <section aria-labelledby="rules-h" className="rounded-md border border-rule bg-surface">
        <h2 id="rules-h" className="border-b border-rule px-4 py-3 text-lg font-bold">Rules</h2>
        <dl className="grid gap-x-6 gap-y-2 px-4 py-3 text-sm sm:grid-cols-[16rem_1fr]">
          {rules.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-ink-3">{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="vendors-h" className="rounded-md border border-rule bg-surface">
        <h2 id="vendors-h" className="border-b border-rule px-4 py-3 text-lg font-bold">Vendor master</h2>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[48rem] text-left text-sm">
            <thead className="border-b border-rule text-ink-2">
              <tr>
                <th className="px-4 py-2 font-semibold">Vendor</th>
                <th className="px-4 py-2 font-semibold">GSTIN</th>
                <th className="px-4 py-2 font-semibold">Bank account ending</th>
                <th className="px-4 py-2 font-semibold">Terms</th>
                <th className="px-4 py-2 font-semibold">Registered senders</th>
                <th className="px-4 py-2 font-semibold">Phone for bank checks</th>
              </tr>
            </thead>
            <tbody>
              {ref.vendors.map((v) => (
                <tr key={v.vendor_id} className="border-b border-rule last:border-b-0 align-top">
                  <td className="px-4 py-2">
                    <span className="font-semibold">{v.legal_name}</span> <span className="text-xs text-ink-3">{v.vendor_id}</span>
                  </td>
                  <td className="num px-4 py-2">{v.gstin ?? "none"}</td>
                  <td className="num px-4 py-2">{v.bank_last4}</td>
                  <td className="num px-4 py-2">{v.payment_terms_days} days</td>
                  <td className="px-4 py-2">{v.registered_senders.join(", ")}</td>
                  <td className="num px-4 py-2">{v.phone}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="po-h" className="rounded-md border border-rule bg-surface">
        <h2 id="po-h" className="border-b border-rule px-4 py-3 text-lg font-bold">Purchase orders</h2>
        <ul className="divide-y divide-rule">
          {ref.purchaseOrders.map((po) => (
            <li key={po.po_number} className="px-4 py-3 text-sm">
              <p>
                <span className="font-semibold">{po.po_number}</span>
                <span className="text-ink-2">
                  {" "}
                  {ref.vendors.find((v) => v.vendor_id === po.vendor_id)?.legal_name ?? po.vendor_id}, {formatDate(po.po_date)}, {po.status}, prices{" "}
                  {po.price_basis === "inclusive" ? "include GST" : "before GST"}, subtotal {formatInr(paiseToRupees(po.subtotal_pretax))}
                </span>
              </p>
              <ul className="mt-1 space-y-0.5 text-ink-2">
                {po.lines.map((l) => (
                  <li key={l.line_no} className="num">
                    Line {l.line_no}: {l.description}, {l.qty_ordered} {l.uom} at {l.unit_price_pretax}
                    {l.line_kind === "charge" ? " (approved charge)" : ""}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="cat-h" className="rounded-md border border-rule bg-surface">
        <h2 id="cat-h" className="border-b border-rule px-4 py-3 text-lg font-bold">Unit conversions (catalog)</h2>
        <ul className="divide-y divide-rule text-sm">
          {ref.catalog.map((c) => (
            <li key={c.item_code} className="px-4 py-2">
              <span className="font-semibold">{c.item_code}</span> {c.description}: 1 {c.pack_uom} = {c.pack_size} {c.base_uom}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
