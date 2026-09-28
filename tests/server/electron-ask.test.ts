import {
  appleScriptChoice,
  appleScriptField,
  parseAppleScriptAnswer,
  parseWindowsAnswer,
  windowsEncodedCommand,
  windowsFormScript,
  zenityChoiceArgs,
  zenityFieldArgs,
  type AskForm,
} from '@/lib/server/electron/ask';

const form = (overrides: Partial<AskForm> = {}): AskForm => ({
  cancel: 'Cancel',
  message: 'Where should the data come from?',
  ok: 'Save',
  title: 'CodeBuddy2API',
  ...overrides,
});

describe('appleScriptChoice', () => {
  it('makes the options the buttons, with the first one already picked', () => {
    const script = appleScriptChoice(
      form({ options: ['This machine', 'A deployment'] }),
    );

    expect(script).toContain('buttons {"This machine", "A deployment"}');
    expect(script).toContain('default button "This machine"');
    expect(script).toContain('with title "CodeBuddy2API"');
  });

  it('escapes what would otherwise end the string it sits in', () => {
    expect(
      appleScriptChoice(form({ message: 'Say "hi" \\ now', options: ['a'] })),
    ).toContain('display dialog "Say \\"hi\\" \\\\ now"');
  });
});

describe('appleScriptField', () => {
  it('asks with the value already in the field', () => {
    const script = appleScriptField(form(), {
      label: 'Port',
      value: '8001',
    });

    expect(script).toContain('default answer "8001"');
    expect(script).toContain('buttons {"Cancel", "Save"}');
    expect(script).toContain('default button "Save"');
  });

  it('says what the field is for, then what went wrong, then what it is', () => {
    const script = appleScriptField(
      form({ error: 'Enter a whole number.', message: 'Port 8001 is in use' }),
      { label: 'Port', value: '8002' },
    );

    expect(script).toContain(
      'display dialog "Port 8001 is in use\n\nEnter a whole number.\n\nPort"',
    );
  });

  // The address of a deployment is not asked under a question about the backend:
  // each field carries the words that belong to it.
  it('asks in the words of the field when it has its own', () => {
    const script = appleScriptField(form({ message: 'Choose a backend' }), {
      label: 'Address',
      message: 'Where the deployment answers',
      value: '',
    });

    expect(script).toContain(
      'display dialog "Where the deployment answers\n\nAddress"',
    );
  });
});

describe('parseAppleScriptAnswer', () => {
  it('reads the button and what was typed', () => {
    expect(
      parseAppleScriptAnswer(
        'button returned:Save, text returned:8001, gave up:false',
      ),
    ).toEqual({ button: 'Save', gaveUp: false, text: '8001' });
  });

  it('keeps an answer that holds a comma', () => {
    expect(
      parseAppleScriptAnswer(
        'button returned:Save, text returned:8080, 8001, gave up:false',
      ).text,
    ).toBe('8080, 8001');
  });

  it('knows a dialog that went away on its own', () => {
    const answer = parseAppleScriptAnswer(
      'button returned:, text returned:8001, gave up:true',
    );

    expect(answer.gaveUp).toBe(true);
    expect(answer.button).toBe('');
  });

  it('says nothing about an answer it was never given', () => {
    expect(parseAppleScriptAnswer('')).toEqual({
      button: null,
      gaveUp: false,
      text: null,
    });
  });
});

describe('windowsFormScript', () => {
  it("draws a form of the system's own controls", () => {
    const script = windowsFormScript(
      form({
        fields: [{ label: 'Port', value: '8001' }],
        options: ['This machine', 'A deployment'],
      }),
    );

    expect(script).toContain('Add-Type -AssemblyName System.Windows.Forms');
    expect(script).toContain(
      '[System.Windows.Forms.Application]::EnableVisualStyles()',
    );
    expect(script).toContain('New-Object System.Windows.Forms.RadioButton');
    expect(script).toContain('New-Object System.Windows.Forms.TextBox');
    expect(script).toContain('$form.ShowInTaskbar = $false');
  });

  it('writes a quote twice, so PowerShell reads it back as one', () => {
    expect(windowsFormScript(form({ message: "It's here" }))).toContain(
      "It''s here",
    );
  });

  it('puts what went wrong above the question, in the colour that says so', () => {
    const script = windowsFormScript(
      form({
        error: 'Enter a whole number.',
        fields: [{ label: 'Port', value: '8002' }],
      }),
    );

    expect(script).toContain("$label0.Text = 'Enter a whole number.'");
    expect(script).toContain(
      '$label0.ForeColor = [System.Drawing.Color]::Firebrick',
    );
    // The question is the label after it: the one on top is not the message.
    expect(script).toContain(
      "$label1.Text = 'Where should the data come from?'",
    );
  });

  it('lets a field be typed into only when its option is picked', () => {
    const script = windowsFormScript(
      form({
        fields: [{ label: 'Address', option: 1, value: '' }],
        options: ['This machine', 'A deployment'],
      }),
    );

    expect(script).toContain('$field0.Enabled = $option1.Checked');
    expect(script).toContain(
      '$option1.Add_CheckedChanged({ $field0.Enabled = $option1.Checked })',
    );
  });

  it('leaves a field that belongs to no option alone', () => {
    const script = windowsFormScript(
      form({ fields: [{ label: 'Port', value: '8001' }] }),
    );

    expect(script).not.toContain('.Enabled =');
  });

  it('prints the option picked and then every field, and nothing when cancelled', () => {
    const script = windowsFormScript(
      form({
        fields: [
          { label: 'Address', option: 1, value: '' },
          { label: 'Port', value: '8001' },
        ],
        options: ['This machine', 'A deployment'],
      }),
    );

    expect(script).toContain(
      'if ($form.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { exit 0 }',
    );
    expect(script).toContain(
      "if ($option1.Checked) { $picked = 'A deployment' }",
    );
    expect(script).toContain('Write-Output $picked');
    // A field belonging to an option that was not picked answers empty, so the
    // lines stay in the order the fields were given.
    expect(script).toContain(
      "if ($field0.Enabled) { Write-Output $field0.Text } else { Write-Output '' }",
    );
    expect(
      script.endsWith(
        "if ($field1.Enabled) { Write-Output $field1.Text } else { Write-Output '' }",
      ),
    ).toBe(true);
  });

  it('asks without a choice when there is nothing to choose between', () => {
    const script = windowsFormScript(
      form({ fields: [{ label: 'Port', value: '8001' }] }),
    );

    expect(script).not.toContain('Write-Output $picked');
  });
});

describe('windowsEncodedCommand', () => {
  it('carries the script whole, whatever language it is written in', () => {
    const script = windowsFormScript(form({ message: 'ポート' }));
    const encoded = windowsEncodedCommand(script);

    expect(Buffer.from(encoded, 'base64').toString('utf16le')).toBe(script);
  });
});

describe('parseWindowsAnswer', () => {
  it('reads one line per answer', () => {
    expect(
      parseWindowsAnswer('A deployment\r\nhttps://up.example.com\r\n8001\r\n'),
    ).toEqual(['A deployment', 'https://up.example.com', '8001']);
  });

  it('ignores the mark PowerShell may put at the front', () => {
    expect(parseWindowsAnswer('﻿8001\n')).toEqual(['8001']);
  });

  it('keeps the empty lines a field that was not asked for leaves', () => {
    expect(parseWindowsAnswer('\n8001\n')).toEqual(['', '8001']);
  });

  // A form dismissed with Cancel prints nothing at all.
  it('reads no answer in nothing', () => {
    expect(parseWindowsAnswer('')).toBeNull();
    expect(parseWindowsAnswer('\r\n\n')).toBeNull();
  });
});

describe('zenity', () => {
  it('offers the options as a list', () => {
    expect(
      zenityChoiceArgs(form({ options: ['This machine', 'A deployment'] })),
    ).toEqual([
      '--list',
      '--title',
      'CodeBuddy2API',
      '--text',
      'Where should the data come from?',
      '--hide-header',
      '--column',
      'CodeBuddy2API',
      'This machine',
      'A deployment',
    ]);
  });

  it('asks with no row to pick when there is no choice to offer', () => {
    expect(zenityChoiceArgs(form())).toEqual([
      '--list',
      '--title',
      'CodeBuddy2API',
      '--text',
      'Where should the data come from?',
      '--hide-header',
      '--column',
      'CodeBuddy2API',
    ]);
  });

  it('asks for one value in an entry', () => {
    expect(zenityFieldArgs(form(), { label: 'Port', value: '8001' })).toEqual([
      '--entry',
      '--title',
      'CodeBuddy2API',
      '--text',
      'Where should the data come from?\n\nPort',
      '--entry-text',
      '8001',
      '--ok-label',
      'Save',
      '--cancel-label',
      'Cancel',
    ]);
  });
});
