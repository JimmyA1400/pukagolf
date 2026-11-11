import { SignupFlow } from "@/components/SignupFlow";

/**
 * Join the league.
 *
 * Deliberately separate from /sign-in: signing up collects golf details and
 * RSVPs, and folding that into the sign-in form would put five extra fields in
 * front of returning members every time.
 */
export default function Signup() {
  return <SignupFlow />;
}
