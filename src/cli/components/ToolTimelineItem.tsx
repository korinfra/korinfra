export function formatToolNameForStatus(name: string): string {
  const parts = name.split('__');
  const raw = parts.length >= 3 && parts[0] === 'mcp' ? parts.slice(2).join(' ') : name;
  const readable = raw.replace(/_/g, ' ');
  return readable.charAt(0).toUpperCase() + readable.slice(1) + '…';
}
