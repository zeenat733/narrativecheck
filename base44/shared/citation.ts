// Shared by backend functions: INA <-> USC crosswalk and citation matching.
export const INA_TO_USC = {
  275: '1325',
  276: '1326',
  212: '1182',
  237: '1227',
};

export function citationKey(value) {
  const text = String(value || '').toLowerCase();
  const match = text.match(/(\d{3,4})/);
  if (!match) return '';
  const section = match[1];
  const canonical = INA_TO_USC[section] || section;
  const remainder = text.slice(match.index + section.length).replace(/[^a-z0-9]/g, '');
  return canonical + remainder;
}

export function findChargeReference(chargeRefs, selectedCharge) {
  const key = citationKey(selectedCharge);
  if (!key) return null;

  const refs = chargeRefs || [];
  const keys = refs.map((ref) => ({
    ref,
    keys: [ref.code, ref.uscCitation, ref.inaCitation].map(citationKey).filter(Boolean),
  }));

  const exact = keys.filter((entry) => entry.keys.includes(key));
  if (exact.length === 1) return exact[0].ref;

  const related = keys.filter((entry) =>
    entry.keys.some((refKey) => refKey.startsWith(key) || key.startsWith(refKey))
  );
  return related.length === 1 ? related[0].ref : null;
}