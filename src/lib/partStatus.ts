export function usePartStatusMark(partId: string): '' | '(-)' | '(f)' { return ''; }
export function isPartFixed(partId: string): boolean { return false; }
export function setPartFixed(partId: string, fixed: boolean): void {}
