export function formatUser(user) {
  const name = user.name.trim().replace(/\s+/g, ' ');
  const initials = name
    .split(' ')
    .map((part) => part[0].toUpperCase())
    .join('');
  return `${name} (${initials})`;
}

export function formatTeam(team) {
  const name = team.name.trim().replace(/\s+/g, ' ');
  const initials = name
    .split(' ')
    .map((part) => part[0].toUpperCase())
    .join('');
  return `Team ${name} [${initials}]`;
}
