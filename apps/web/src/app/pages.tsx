import { Link } from 'react-router';

export function SearchPage() {
  return (
    <section aria-labelledby="search-title">
      <h1 id="search-title" className="mb-2 text-3xl font-bold text-heading">Search</h1>
      <p className="text-muted">Search every note, or ask one a question. Coming soon.</p>
    </section>
  );
}

export function SettingsPage() {
  return (
    <section aria-labelledby="settings-title">
      <h1 id="settings-title" className="mb-2 text-3xl font-bold text-heading">Settings</h1>
      <p className="text-muted">Your plan, data retention, help and your account. Coming soon.</p>
    </section>
  );
}

export function NotFoundPage() {
  return (
    <section aria-labelledby="nf-title">
      <h1 id="nf-title" className="mb-2 text-3xl font-bold text-heading">Page not found</h1>
      <p className="text-muted">
        That page doesn't exist. <Link to="/">Go to your notes</Link>.
      </p>
    </section>
  );
}
