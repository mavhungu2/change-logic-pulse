import { useState } from 'react';
import type { ActiveSurvey, Question } from '@api/tenancy/contract.js';
import { ApiError, api } from './api';
import { ErrorPanel, Loading, NoticePanel } from './Feedback';
import { useAsync } from './useAsync';

type AnswerValue = number | boolean;

/** Per-survey submit state, so one card's 409 does not blank the others. */
type SubmitState =
  | { kind: 'editing' }
  | { kind: 'submitting' }
  | { kind: 'submitted' }
  | { kind: 'already-responded'; submittedAt: string | null }
  | { kind: 'failed'; message: string };

function QuestionField({
  question,
  value,
  onChange,
  disabled,
}: {
  question: Question;
  value: AnswerValue | undefined;
  onChange: (value: AnswerValue) => void;
  disabled: boolean;
}) {
  // Radios rather than a free text field: an out-of-range rating or a
  // non-boolean is not expressible, so there is no client validation to write.
  const options: { label: string; value: AnswerValue }[] =
    question.type === 'rating'
      ? [1, 2, 3, 4, 5].map((n) => ({ label: String(n), value: n }))
      : [
          { label: 'Yes', value: true },
          { label: 'No', value: false },
        ];

  return (
    <fieldset disabled={disabled}>
      <legend>{question.text}</legend>
      <div className="options">
        {options.map((option) => (
          <label key={String(option.value)} className="option">
            <input
              type="radio"
              name={question.id}
              // Without this the input has no accessible name — the visible
              // text is a sibling, and a screen reader announces "on".
              aria-label={`${question.text}: ${option.label}`}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
            />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function SurveyCard({ survey, token }: { survey: ActiveSurvey; token: string }) {
  const [answers, setAnswers] = useState<Record<string, AnswerValue>>({});
  const [state, setState] = useState<SubmitState>(
    survey.alreadyRespondedThisWeek
      ? { kind: 'already-responded', submittedAt: null }
      : { kind: 'editing' },
  );

  const complete = survey.questions.every((question) => answers[question.id] !== undefined);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setState({ kind: 'submitting' });
    try {
      await api(`/surveys/${survey.id}/responses`, {
        method: 'POST',
        token,
        // No week is sent. The server derives it from the ISO calendar week.
        body: {
          answers: survey.questions.map((question) => ({
            questionId: question.id,
            value: answers[question.id],
          })),
        },
      });
      setState({ kind: 'submitted' });
    } catch (caught) {
      const error = caught as ApiError;
      if (error.status === 409) {
        // Not a failure. The member already answered — most likely in another
        // tab, or on another device — so this reads as the normal
        // already-responded state, the same one they see on return.
        setState({
          kind: 'already-responded',
          submittedAt: typeof error.body?.submittedAt === 'string' ? error.body.submittedAt : null,
        });
        return;
      }
      setState({ kind: 'failed', message: error.message });
    }
  }

  if (state.kind === 'already-responded') {
    return (
      <section className="card">
        <h3>{survey.title}</h3>
        <NoticePanel>
          <strong>You have already answered this week.</strong>
          <p className="muted">
            {state.submittedAt
              ? `Recorded ${new Date(state.submittedAt).toLocaleString()}.`
              : 'Come back next week — one response per person, per survey, per week.'}
          </p>
        </NoticePanel>
      </section>
    );
  }

  if (state.kind === 'submitted') {
    return (
      <section className="card">
        <h3>{survey.title}</h3>
        <NoticePanel>
          <strong>Thanks — your response is recorded.</strong>
          <p className="muted">You can answer again next week.</p>
        </NoticePanel>
      </section>
    );
  }

  return (
    <form className="card" onSubmit={submit}>
      <h3>{survey.title}</h3>
      {survey.questions.map((question) => (
        <QuestionField
          key={question.id}
          question={question}
          value={answers[question.id]}
          disabled={state.kind === 'submitting'}
          onChange={(value) => setAnswers((current) => ({ ...current, [question.id]: value }))}
        />
      ))}

      {state.kind === 'failed' && <ErrorPanel message={state.message} />}

      <button type="submit" disabled={!complete || state.kind === 'submitting'}>
        {state.kind === 'submitting' ? 'Submitting…' : 'Submit'}
      </button>
      {!complete && <p className="muted">Answer every question to submit.</p>}
    </form>
  );
}

export function MemberFlow({ token }: { token: string }) {
  const { state, reload } = useAsync(
    () => api<ActiveSurvey[]>('/surveys/active', { token }),
    [token],
  );

  if (state.status === 'loading') return <Loading what="your active surveys" />;
  if (state.status === 'error') return <ErrorPanel message={state.error.message} onRetry={reload} />;
  if (state.data.length === 0) {
    return <NoticePanel>No active surveys for your organization right now.</NoticePanel>;
  }

  return (
    <>
      {state.data.map((survey) => (
        <SurveyCard key={survey.id} survey={survey} token={token} />
      ))}
    </>
  );
}
