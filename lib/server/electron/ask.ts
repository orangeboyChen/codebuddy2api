/**
 * The questions the shell has to ask before there is anything to show — which
 * backend, which port — asked in the computer's own dialogs.
 *
 * A page of this app's is dressed by this app, and can only ever look like a
 * page of this app's: `electron/backend.html` is that page, and a machine with
 * no dialog of its own to offer still gets it. Everywhere else the question is
 * put to the desktop instead — AppKit's dialog on macOS, a WinForms form on
 * Windows, zenity's on Linux. Each is drawn by the desktop, in the appearance
 * the desktop is in, with the buttons the desktop uses, so there is nothing of
 * ours on the screen to get wrong — including on a dark desktop, where the
 * dialog that answers is a dark one.
 *
 * Nothing here runs anything. What is here is the command each platform is
 * handed, and the reading of what it answers back; the shell does the running.
 */

/** One thing the question asks for, and the option it belongs to, if any. */
export interface AskField {
  /**
   * The option that has to be picked for this field to mean anything: the
   * address of a deployment is only asked when a deployment is what was chosen.
   */
  option?: number;
  label: string;
  /** What this field is for, when the question above it is about something else. */
  message?: string;
  value: string;
}

/** The question, in the words the shell has for it. */
export interface AskForm {
  cancel: string;
  /** An answer the app would not take, asked again with the reason above it. */
  error?: string;
  fields?: AskField[];
  message: string;
  ok: string;
  /** Empty when there is nothing to choose between. */
  options?: string[];
  title: string;
}

export interface AskAnswer {
  /** The option that was picked, or null when there was nothing to choose. */
  option: string | null;
  /**
   * One entry per field, in the order they were given. A field that was not
   * asked for — one belonging to an option the user did not pick — is empty.
   */
  values: string[];
}

/**
 * What a dialog is showing above a field: what is being asked for, what went
 * wrong the last time, and what this field is.
 */
const fieldMessage = (form: AskForm, field: AskField): string =>
  [field.message ?? form.message, form.error, field.label]
    .filter(Boolean)
    .join('\n\n');

/*
 * macOS: AppleScript's `display dialog`, which is the dialog AppKit draws — the
 * one the system puts on the screen for anything that asks in its own language.
 */

/** Inside an AppleScript string, only the backslash and the quote mean anything. */
const appleScriptString = (value: string): string =>
  `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

const appleScriptButtons = (labels: string[]): string =>
  `{${labels.map(appleScriptString).join(', ')}}`;

/** The choice, as a dialog whose buttons are the options themselves. */
export const appleScriptChoice = (form: AskForm): string => {
  const options = form.options ?? [];

  return `display dialog ${appleScriptString(form.message)} buttons ${appleScriptButtons(options)} default button ${appleScriptString(options[0] ?? form.ok)} with title ${appleScriptString(form.title)}`;
};

/** One value, as a dialog with a field in it. */
export const appleScriptField = (form: AskForm, field: AskField): string =>
  `display dialog ${appleScriptString(fieldMessage(form, field))} default answer ${appleScriptString(field.value)} buttons ${appleScriptButtons([form.cancel, form.ok])} default button ${appleScriptString(form.ok)} with title ${appleScriptString(form.title)}`;

export interface AppleScriptAnswer {
  /** The dialog went away on its own, which is not an answer. */
  gaveUp: boolean;
  /** The button pressed, which is the option chosen when there was a choice. */
  button: string | null;
  /** What was typed, on a dialog that has a field. */
  text: string | null;
}

/**
 * What `osascript` prints for a dialog: `button returned:OK, text returned:8001,
 * gave up:false`.
 *
 * The answer itself can hold a comma, so the line is split on the names rather
 * than on every comma.
 */
export const parseAppleScriptAnswer = (stdout: string): AppleScriptAnswer => {
  const answer: AppleScriptAnswer = {
    button: null,
    gaveUp: false,
    text: null,
  };

  for (const part of stdout
    .trim()
    .split(/,\s(?=(?:button|text) returned:|gave up:)/)) {
    const at = part.indexOf(':');

    if (at < 0) {
      continue;
    }

    const name = part.slice(0, at).trim();
    const value = part.slice(at + 1);

    if (name === 'button returned') {
      answer.button = value;
    } else if (name === 'text returned') {
      answer.text = value;
    } else if (name === 'gave up') {
      answer.gaveUp = value.trim() === 'true';
    }
  }

  return answer;
};

/*
 * Windows: a WinForms form — the framework Windows' own dialogs are written in,
 * with the text field, the radio button and the push button Windows draws.
 */

/** Inside a single-quoted PowerShell string, a quote is written twice. */
const windowsString = (value: string): string =>
  `'${value.replace(/'/g, "''")}'`;

/** The width the form's text wraps at, and the fields are drawn to. */
const WINDOWS_FORM_WIDTH = 360;

/**
 * The form, as a PowerShell script.
 *
 * Every value the shell knows is written into it rather than passed beside it,
 * so nothing a user could type into a field is ever read as script.
 */
export const windowsFormScript = (form: AskForm): string => {
  const options = form.options ?? [];
  const fields = form.fields ?? [];
  const lines: string[] = [
    'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
    'Add-Type -AssemblyName System.Drawing | Out-Null',
    '[System.Windows.Forms.Application]::EnableVisualStyles()',
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$form = New-Object System.Windows.Forms.Form',
    `$form.Text = ${windowsString(form.title)}`,
    '$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog',
    '$form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen',
    // The app lives in the notification area, not in the taskbar, and a form it
    // asks in does not either.
    '$form.ShowInTaskbar = $false',
    '$form.ShowIcon = $false',
    '$form.MinimizeBox = $false',
    '$form.MaximizeBox = $false',
    '$form.TopMost = $true',
    '$form.AutoSize = $true',
    '$form.AutoSizeMode = [System.Windows.Forms.AutoSizeMode]::GrowAndShrink',
    '$form.Padding = New-Object System.Windows.Forms.Padding(16)',
    '$panel = New-Object System.Windows.Forms.FlowLayoutPanel',
    '$panel.FlowDirection = [System.Windows.Forms.FlowDirection]::TopDown',
    '$panel.WrapContents = $false',
    '$panel.AutoSize = $true',
    '$panel.AutoSizeMode = [System.Windows.Forms.AutoSizeMode]::GrowAndShrink',
    '$form.Controls.Add($panel)',
  ];

  let labels = 0;

  const addLabel = (
    text: string,
    extra: (name: string) => string[] = () => [],
  ): void => {
    const name = `$label${labels}`;

    labels += 1;
    lines.push(
      `${name} = New-Object System.Windows.Forms.Label`,
      `${name}.Text = ${windowsString(text)}`,
      `${name}.AutoSize = $true`,
      `${name}.MaximumSize = New-Object System.Drawing.Size(${WINDOWS_FORM_WIDTH}, 0)`,
      ...extra(name),
      `$panel.Controls.Add(${name})`,
    );
  };

  if (form.error) {
    addLabel(form.error, (name) => [
      `${name}.ForeColor = [System.Drawing.Color]::Firebrick`,
    ]);
  }

  addLabel(form.message);

  options.forEach((option, index) => {
    const name = `$option${index}`;

    lines.push(
      `${name} = New-Object System.Windows.Forms.RadioButton`,
      `${name}.Text = ${windowsString(option)}`,
      `${name}.AutoSize = $true`,
      `${name}.MaximumSize = New-Object System.Drawing.Size(${WINDOWS_FORM_WIDTH}, 0)`,
      index === 0 ? `${name}.Checked = $true` : '',
      `$panel.Controls.Add(${name})`,
    );
  });

  fields.forEach((field, index) => {
    const name = `$field${index}`;

    addLabel(field.label);
    lines.push(
      `${name} = New-Object System.Windows.Forms.TextBox`,
      `${name}.Text = ${windowsString(field.value)}`,
      `${name}.Width = ${WINDOWS_FORM_WIDTH}`,
      `$panel.Controls.Add(${name})`,
    );

    if (field.option !== undefined && options[field.option]) {
      const radio = `$option${field.option}`;

      // Only a field belonging to the option that is picked can be typed into.
      lines.push(
        `${name}.Enabled = ${radio}.Checked`,
        `${radio}.Add_CheckedChanged({ ${name}.Enabled = ${radio}.Checked })`,
      );
    }
  });

  lines.push(
    // The buttons go through the same flow as everything above them: a form
    // sized to its contents, rather than one docked to an edge it has to guess
    // the width of.
    '$buttons = New-Object System.Windows.Forms.FlowLayoutPanel',
    '$buttons.FlowDirection = [System.Windows.Forms.FlowDirection]::RightToLeft',
    '$buttons.WrapContents = $false',
    '$buttons.AutoSize = $true',
    '$buttons.AutoSizeMode = [System.Windows.Forms.AutoSizeMode]::GrowAndShrink',
    `$buttons.Width = ${WINDOWS_FORM_WIDTH}`,
    '$panel.Controls.Add($buttons)',
    '$ok = New-Object System.Windows.Forms.Button',
    `$ok.Text = ${windowsString(form.ok)}`,
    '$ok.DialogResult = [System.Windows.Forms.DialogResult]::OK',
    '$cancel = New-Object System.Windows.Forms.Button',
    `$cancel.Text = ${windowsString(form.cancel)}`,
    '$cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel',
    '$buttons.Controls.Add($ok)',
    '$buttons.Controls.Add($cancel)',
    '$form.AcceptButton = $ok',
    '$form.CancelButton = $cancel',
    'if ($form.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { exit 0 }',
  );

  if (options.length) {
    lines.push("$picked = ''");

    options.forEach((option, index) => {
      lines.push(
        `if ($option${index}.Checked) { $picked = ${windowsString(option)} }`,
      );
    });

    lines.push('Write-Output $picked');
  }

  fields.forEach((_field, index) => {
    lines.push(
      `if ($field${index}.Enabled) { Write-Output $field${index}.Text } else { Write-Output '' }`,
    );
  });

  return lines.filter(Boolean).join('\n');
};

/**
 * The command Windows PowerShell is given.
 *
 * The script travels encoded, which is the one way a program is handed
 * PowerShell that no quoting in between can change: a question translated into
 * Japanese, or an address with an apostrophe in it, arrives as it was written.
 */
export const windowsEncodedCommand = (script: string): string =>
  Buffer.from(script, 'utf16le').toString('base64');

/**
 * What the form prints: one line for the option picked, then one line per field,
 * and nothing at all when the form was cancelled.
 *
 * A field that was not asked for prints an empty line, so the lines stay in the
 * order the fields were given.
 */
export const parseWindowsAnswer = (stdout: string): string[] | null => {
  const lines = stdout
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .map((line) => line.trim());

  while (lines.length && lines[lines.length - 1] === '') {
    lines.pop();
  }

  return lines.length ? lines : null;
};

/*
 * Linux: zenity, which draws with GTK — the toolkit the desktop in front of the
 * user is drawn with.
 */

/** The choice, as a list with the first option picked. */
export const zenityChoiceArgs = (form: AskForm): string[] => [
  '--list',
  '--title',
  form.title,
  '--text',
  form.message,
  '--hide-header',
  '--column',
  form.title,
  ...(form.options ?? []),
];

/** One value, as an entry dialog. */
export const zenityFieldArgs = (form: AskForm, field: AskField): string[] => [
  '--entry',
  '--title',
  form.title,
  '--text',
  fieldMessage(form, field),
  '--entry-text',
  field.value,
  '--ok-label',
  form.ok,
  '--cancel-label',
  form.cancel,
];
