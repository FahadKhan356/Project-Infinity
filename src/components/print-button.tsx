'use client';

export function PrintButton() {
  return (
    <div className="mx-auto mb-4 flex max-w-3xl justify-end print:hidden">
      <button type="button" onClick={() => window.print()}
        className="rounded-md bg-black px-3 py-1.5 text-sm font-medium text-white">Print / Save as PDF</button>
    </div>
  );
}
