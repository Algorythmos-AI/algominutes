import { Link } from 'react-router';

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
