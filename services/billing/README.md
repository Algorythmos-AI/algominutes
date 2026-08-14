# services/billing (NOT BUILT — A9)

Store receipt validation, Stripe + store webhooks, entitlement writes. Separate security posture and
public webhook endpoints; must not share a scaling pool with user traffic (§3.2). Built in **A9 (revenue
layer)**. Operating cost: one sync Cloud Run service + webhook endpoints + a dashboard/alert.
