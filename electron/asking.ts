/**
 * One question at a time, and the one its answer raised.
 *
 * A question stays in front of the user until its answer has been applied, and
 * the answer is what can raise the next one: a deployment that turns out to be
 * unreachable only once it is tried, a port that turns out to be taken after
 * all. Raised from inside the ask it came out of, the second question met the
 * guard that keeps two from being asked at once — and was dropped by it. The
 * app sat with nothing on screen, having decided nothing, while the launch it
 * was deciding about went on as though it had.
 *
 * So the question an answer raises is kept until the question it came out of is
 * over, and asked then: an answer that did not take is one the user has to be
 * asked about again.
 */
export interface Asking<T> {
  /** Whether a question is in front of the user right now. */
  readonly asking: boolean;
  /**
   * Says a question has been put in front of the user: no, if one already is.
   */
  begin: () => boolean;
  /**
   * Says the question in front of the user is over — and puts the one its
   * answer raised there, which is now the moment it can be.
   */
  end: () => void;
  /**
   * Puts a question in front of the user, or keeps it for when the one there
   * is over: the answer to a question is where the next one comes from.
   */
  raise: (question: T) => void;
}

/**
 * What is kept between the two halves of a question.
 *
 * `ask` is how a question reaches the user, which on this app's screen is a
 * dialog of the desktop's own; the queue only decides when it is asked.
 */
export const askingOneAtATime = <T>(ask: (question: T) => void): Asking<T> => {
  let asking = false;
  let raised: T | null = null;

  return {
    get asking(): boolean {
      return asking;
    },
    begin: () => {
      if (asking) {
        return false;
      }

      asking = true;

      return true;
    },
    end: () => {
      asking = false;

      const next = raised;

      raised = null;

      if (next !== null) {
        ask(next);
      }
    },
    raise: (question) => {
      // A question raised from inside the answer to one is kept: there is
      // already one in front of the user, and two at once is none at all.
      if (asking) {
        raised = question;

        return;
      }

      ask(question);
    },
  };
};
