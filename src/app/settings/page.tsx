import { ArrowRight, FileSpreadsheet, PencilLine, ShieldCheck, UserRound } from "lucide-react";
import { paiseToRupees } from "@/domain/money";
import { loadReferenceData } from "@/fixtures/load";
import { formatDate, formatInr } from "@/lib/format";
import { withDemoSenders } from "@/server/runtime";
import { Panel } from "@/ui/kit";
import { PageHeader } from "@/ui/shell";

// Spec 8: the settings and reference data every check uses, shown read-only.

const STEPS = [
  {
    icon: PencilLine,
    title: "Read",
    who: "AI model (MOCK answer key on a test setup)",
    text: "Reads the document into fields and lines. It never decides, computes a total that counts, or changes a state.",
  },
  {
    icon: ShieldCheck,
    title: "Check",
    who: "Code",
    text: "Verifies every value against the document text, the vendor master and the purchase order, then clears or holds it with a reason.",
  },
  {
    icon: UserRound,
    title: "Decide",
    who: "A person",
    text: "Approves, requests a correction, or rejects. Overrides need a note, and bank or identity holds need a recorded phone call.",
  },
  { icon: FileSpreadsheet, title: "Export", who: "A person", text: "Approved invoices go to finance as a CSV payment list. Payment itself happens in finance's own process." },
];

export default function SettingsPage() {
  const ref = withDemoSenders(loadReferenceData());
  const s = ref.settings;
  const rules: [string, string, string][] = [
    ["Price tolerance", `${s.price_tolerance_pct}% above the PO price`, "C1, C3, M7"],
    ["Quantity tolerance", `${s.quantity_tolerance_pct}% above the ordered quantity`, "C2"],
    ["Rounding tolerance", `₹${s.rounding_tolerance_inr} on totals and tax`, "V2, T3"],
    ["Approval limit", formatInr(String(s.approval_limit_inr)) ?? "", "C5"],
    ["AP forwarding addresses", s.ap_forwarder_allowlist.join(", "), "K3"],
    ["Charge keywords", s.charge_keywords.join(", "), "M7"],
    ["Lump-sum markers", [...s.lump_sum_markers.phrases, ...s.lump_sum_markers.units.map((u) => `unit "${u}"`)].join(", "), "M5"],
    ["Buyer", `${s.buyer.name}, GSTIN ${s.buyer.gstin} (a vendor GSTIN equal to it is refused as a misreading)`, "A14"],
  ];
  const vendorName = (id: string) => ref.vendors.find((v) => v.vendor_id === id)?.legal_name ?? id;
  return (
    <div className="space-y-5">
      <PageHeader
        crumbs={[{ label: "Setup" }, { label: "Rules and reference data" }]}
        title="Rules and reference data"
        meta="What every check compares against. These come from the test-data files (fictional), stand in for the ERP and are read-only here: a vendor or a PO is changed in the source system, not in this tool."
      />

      <Panel title="How a decision is made" description="Who does what, in order. The review screen tags every value and finding with the same marks.">
        <ol className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {STEPS.map((st, i) => (
            <li key={st.title} className="relative rounded-md border border-rule bg-surface-2 px-3 py-3">
              <p className="flex items-center gap-2 text-[14px] font-semibold text-ink">
                <span
                  className={`flex h-6 w-6 items-center justify-center rounded-full ${i === 0 ? "border border-dashed border-graphite text-ink-2" : "bg-carbon-wash text-carbon-deep"}`}
                >
                  <st.icon aria-hidden size={13} />
                </span>
                {i + 1}. {st.title}
                {i < STEPS.length - 1 && <ArrowRight aria-hidden size={14} className="ml-auto hidden text-ink-3 xl:block" />}
              </p>
              <p className="mt-1 text-[12px] font-semibold text-ink-2">{st.who}</p>
              <p className="mt-1 text-[13px] text-ink-2">{st.text}</p>
            </li>
          ))}
        </ol>
      </Panel>

      <Panel title="Rules" description="The thresholds the checks apply. The code beside each rule is its section in the workflow spec." flush>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[36rem] text-left text-[13px]">
            <thead className="border-b border-rule bg-surface-2 text-[12px] text-ink-2">
              <tr>
                <th scope="col" className="px-4 py-2 font-semibold">
                  Rule
                </th>
                <th scope="col" className="px-4 py-2 font-semibold">
                  Value
                </th>
                <th scope="col" className="px-4 py-2 font-semibold">
                  Spec
                </th>
              </tr>
            </thead>
            <tbody>
              {rules.map(([k, v, spec]) => (
                <tr key={k} className="border-b border-rule align-top last:border-b-0">
                  <th scope="row" className="px-4 py-2 font-medium text-ink">
                    {k}
                  </th>
                  <td className="px-4 py-2 text-ink-2">{v}</td>
                  <td className="px-4 py-2 font-mono text-[12px] whitespace-nowrap text-ink-3">{spec}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="Vendor master" description="The phone number here is the only one used for bank, identity and sender call-backs." flush>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[52rem] text-left text-[13px]">
            <thead className="border-b border-rule bg-surface-2 text-[12px] text-ink-2">
              <tr>
                <th scope="col" className="px-4 py-2 font-semibold">
                  Vendor
                </th>
                <th scope="col" className="px-4 py-2 font-semibold">
                  GSTIN
                </th>
                <th scope="col" className="px-4 py-2 font-semibold">
                  Bank account ending
                </th>
                <th scope="col" className="px-4 py-2 text-right font-semibold">
                  Terms
                </th>
                <th scope="col" className="px-4 py-2 font-semibold">
                  Registered senders
                </th>
                <th scope="col" className="px-4 py-2 font-semibold">
                  Call-back phone
                </th>
              </tr>
            </thead>
            <tbody>
              {ref.vendors.map((v) => (
                <tr key={v.vendor_id} className="border-b border-rule align-top last:border-b-0">
                  <td className="px-4 py-2.5">
                    <span className="font-semibold text-ink">{v.legal_name}</span> <span className="font-mono text-[11px] text-ink-3">{v.vendor_id}</span>
                  </td>
                  <td className="num px-4 py-2.5">{v.gstin ?? <span className="text-ink-3">none</span>}</td>
                  <td className="num px-4 py-2.5">{v.bank_last4}</td>
                  <td className="num px-4 py-2.5 text-right">{v.payment_terms_days} days</td>
                  <td className="px-4 py-2.5 break-all text-ink-2">{v.registered_senders.join(", ")}</td>
                  <td className="num px-4 py-2.5 whitespace-nowrap">{v.phone}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="Purchase orders" description="Invoice lines are matched to these lines; prices are compared per PO unit." flush>
        <ul className="divide-y divide-rule">
          {ref.purchaseOrders.map((po) => (
            <li key={po.po_number} className="px-4 py-3 text-[13px]">
              <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="num font-semibold text-ink">{po.po_number}</span>
                <span className="text-ink">{vendorName(po.vendor_id)}</span>
                <span className={`rounded px-1.5 text-[12px] font-medium ${po.status === "open" ? "bg-ok-bg text-ok-fg" : "bg-muted-bg text-muted-fg"}`}>{po.status}</span>
                <span className="text-ink-3">
                  {formatDate(po.po_date)}, prices {po.price_basis === "inclusive" ? "include GST" : "before GST"}, subtotal{" "}
                  <span className="num">{formatInr(paiseToRupees(po.subtotal_pretax))}</span>
                </span>
              </p>
              <table className="mt-2 w-full max-w-3xl text-[12px]">
                <tbody>
                  {po.lines.map((l) => (
                    <tr key={l.line_no} className="border-t border-rule first:border-t-0">
                      <td className="num w-10 py-1 text-ink-3">{l.line_no}</td>
                      <td className="py-1 pr-3 text-ink-2">
                        {l.description}
                        {l.line_kind === "charge" && <span className="ml-2 rounded bg-carbon-wash px-1 text-[11px] text-carbon-deep">approved charge</span>}
                      </td>
                      <td className="num py-1 pr-3 text-right whitespace-nowrap text-ink-2">
                        {l.qty_ordered} {l.uom}
                      </td>
                      <td className="num py-1 text-right whitespace-nowrap text-ink-2">at {l.unit_price_pretax}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel title="Unit conversions" description="The catalog the code uses to convert a billed pack into the PO unit." flush>
        <ul className="divide-y divide-rule text-[13px]">
          {ref.catalog.map((c) => (
            <li key={c.item_code} className="flex flex-wrap items-baseline gap-x-3 px-4 py-2">
              <span className="font-mono text-[12px] text-ink-3">{c.item_code}</span>
              <span className="text-ink">{c.description}</span>
              <span className="num text-ink-2">
                1 {c.pack_uom} = {c.pack_size} {c.base_uom}
              </span>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
