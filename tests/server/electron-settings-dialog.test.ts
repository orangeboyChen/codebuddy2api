import {
  appleScriptSettings,
  parseSettingsAnswer,
  settingsTabForm,
  windowsSettingsScript,
  zenitySettingsNoteArgs,
  zenitySettingsTabArgs,
  type SettingsForm,
} from '@/lib/server/electron/settings-dialog';

const form = (): SettingsForm => ({
  cancel: 'Cancel',
  ok: 'Save',
  tabs: [
    {
      fields: [
        { label: 'Address', value: 'https://codebuddy.example.com' },
        { label: 'Port', value: '8001' },
      ],
      label: 'General',
      message: 'Choose a backend',
      option: 1,
      options: ['This machine', 'A deployment I already run'],
    },
    {
      label: 'Data',
      links: [
        { label: '/home/orangeboy/data', url: 'file:///home/orangeboy/data' },
      ],
      notes: ['Data folder /home/orangeboy/data'],
    },
    { label: 'About', notes: ['Version 1.3.15'] },
  ],
  title: 'CodeBuddy2API',
});

describe('appleScriptSettings', () => {
  const script = () => appleScriptSettings(form());

  // A tab view is AppKit's, and not a thing AppleScript can name: the ObjC
  // bridge is the way in, which is why this is JavaScript at all.
  it('asks in the alert AppKit draws, with a tab view inside it', () => {
    const source = script();

    expect(source).toContain("ObjC.import('Cocoa')");
    expect(source).toContain('$.NSTabView.alloc.initWithFrame');
    expect(source).toContain('$.NSAlert.alloc.init');
    expect(source).toContain('alert.setAccessoryView(accessory)');
  });

  // The tabs are a JavaScript value the script's layout loop walks, which is
  // why what is looked for here is the JSON of one.
  it('names every tab, and draws them in order', () => {
    const source = script();
    const at = (label: string): number => source.indexOf(`"${label}"`);

    expect(at('General')).toBeGreaterThan(-1);
    expect(at('General')).toBeLessThan(at('Data'));
    expect(at('Data')).toBeLessThan(at('About'));
  });

  it('puts what the last answer could not be used for on the first tab', () => {
    const source = appleScriptSettings({ ...form(), error: 'Not an address' });

    expect(source.indexOf('Not an address')).toBeLessThan(
      source.indexOf('General'),
    );
  });

  // A label is a JavaScript string: JSON's quoting is what keeps one with a
  // quote or a backslash in it from ending the script early.
  it('escapes a label that would otherwise end the script', () => {
    const source = appleScriptSettings({
      cancel: 'Cancel',
      ok: 'Save',
      tabs: [
        {
          label: 'Say "hello"\\',
          notes: ['a\ttab'],
        },
      ],
      title: 'CodeBuddy2API',
    });

    expect(source).toContain('Say \\"hello\\"\\\\');
    expect(source).toContain('a\\ttab');
  });

  it('answers nothing at all when the dialog was cancelled', () => {
    expect(script()).toContain("if (alert.runModal !== 1000) {\n  ''");
  });

  it('reads the option picked and what was typed back out', () => {
    const source = script();

    expect(source).toContain('selectedRow');
    expect(source).toContain('stringValue');
  });

  // The app lives in the menu bar: a dialog it asks in is not a second app.
  it('asks without putting an icon in the Dock', () => {
    expect(script()).toContain(
      'app.setActivationPolicy($.NSApplicationActivationPolicyAccessory)',
    );
  });
});

describe('windowsSettingsScript', () => {
  const script = () => windowsSettingsScript(form());

  it('draws the tabs Windows draws', () => {
    const source = script();

    expect(source).toContain('New-Object System.Windows.Forms.TabControl');
    expect(source).toContain('$tabs.SelectedIndex = 0');
  });

  it.each([
    { label: 'General', page: '$page0.Text' },
    { label: 'Data', page: '$page1.Text' },
    { label: 'About', page: '$page2.Text' },
  ])('has a page for $label', ({ label, page }) => {
    expect(script()).toContain(`${page} = '${label}'`);
  });

  // The page is named first, but the error is the first thing drawn inside it:
  // a form is read top-down, and this is the line at the top.
  it('says what the last answer could not be used for on the first page', () => {
    const source = windowsSettingsScript({
      ...form(),
      error: 'Not an address',
    });

    expect(source).toContain("'Not an address'");
    expect(source.indexOf('Not an address')).toBeLessThan(
      source.indexOf('Choose a backend'),
    );
    expect(source).toContain('[System.Drawing.Color]::Firebrick');
  });

  // A group of radio buttons in a form is not one control the way AppKit's is:
  // picking one is what has to unpick the others.
  it('keeps the options of a tab to one picked between them', () => {
    const source = script();

    expect(source).toContain(
      '$option0_0.Add_CheckedChanged({ if ($option0_0.Checked) { $option0_1.Checked = $false } })',
    );
    expect(source).toContain(
      '$option0_1.Add_CheckedChanged({ if ($option0_1.Checked) { $option0_0.Checked = $false } })',
    );
  });

  // A folder is a path, not a URL: `Start-Process` is given the one that opens
  // Explorer, which is the path Windows writes — a drive letter and backslashes,
  // not the slashes a URL keeps.
  it.each([
    {
      label: 'C:\\Users\\alice\\data',
      url: 'file:///C:/Users/alice/data',
      why: 'a folder on a drive',
    },
    {
      label: 'C:\\Program Files\\data',
      url: 'file:///C:/Program%20Files/data',
      why: 'a path that had to be escaped',
    },
    {
      label: '\\\\files\\shared\\data',
      url: 'file://files/shared/data',
      why: 'a share on another computer',
    },
  ])('hands the shell $why as the path Windows writes', ({ label, url }) => {
    const windows = form();

    windows.tabs[1].links = [{ label, url }];

    expect(windowsSettingsScript(windows)).toContain(
      `Start-Process '${label}'`,
    );
  });

  it('leaves a link that is not a file the address it is', () => {
    const windows = form();

    windows.tabs[1].links = [
      { label: 'CodeBuddy2API', url: 'https://github.com/orangeboyChen' },
    ];

    expect(windowsSettingsScript(windows)).toContain(
      "Start-Process 'https://github.com/orangeboyChen'",
    );
  });

  it('answers nothing when the form was cancelled', () => {
    expect(script()).toContain(
      'if ($form.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { exit 0 }',
    );
  });

  it('prints the option picked and then what was typed', () => {
    const printed = script()
      .split('\n')
      .filter((line) => line.startsWith('Write-Output'));

    expect(printed).toEqual([
      'Write-Output $picked0',
      'Write-Output $field0_0.Text',
      'Write-Output $field0_1.Text',
    ]);
  });
});

describe('zenity', () => {
  // zenity has no tab control: the sections are a list, and the one picked is
  // what is asked about.
  it('puts the sections in a list', () => {
    expect(zenitySettingsTabArgs(form())).toEqual([
      '--list',
      '--title',
      'CodeBuddy2API',
      '--text',
      'CodeBuddy2API',
      '--hide-header',
      '--column',
      'CodeBuddy2API',
      'General',
      'Data',
      'About',
    ]);
  });

  it('shows a section that only says things', () => {
    expect(zenitySettingsNoteArgs(form().tabs[1])).toEqual([
      '--info',
      '--title',
      'Data',
      '--text',
      'Data folder /home/orangeboy/data\nfile:///home/orangeboy/data',
    ]);
  });

  it('asks a section that asks something as the question it is', () => {
    expect(settingsTabForm(form(), form().tabs[0])).toEqual({
      cancel: 'Cancel',
      error: undefined,
      fields: form().tabs[0].fields,
      message: 'Choose a backend',
      ok: 'Save',
      options: form().tabs[0].options,
      title: 'CodeBuddy2API',
    });
  });
});

describe('parseSettingsAnswer', () => {
  it('reads the option picked and what was typed, per tab', () => {
    expect(
      parseSettingsAnswer('1\nhttps://codebuddy.example.com\n8001\n', form()),
    ).toEqual({
      options: ['A deployment I already run', null, null],
      values: [['https://codebuddy.example.com', '8001'], [], []],
    });
  });

  it('reads a tab that offers options but no fields', () => {
    const only = {
      cancel: 'Cancel',
      ok: 'Save',
      tabs: [{ label: 'General', options: ['This machine', 'Remote'] }],
      title: 'CodeBuddy2API',
    };

    expect(parseSettingsAnswer('0\n', only)).toEqual({
      options: ['This machine'],
      values: [[]],
    });
  });

  it.each([
    { stdout: '', why: 'nothing at all' },
    { stdout: '\n\n', why: 'only blank lines' },
  ])('has no answer for $why', ({ stdout }) => {
    expect(parseSettingsAnswer(stdout, form())).toBeNull();
  });

  // An answer that stops early is one tab short, not one the app should invent
  // a value for: a field left out is empty, which is what the dialog said.
  it('reads a short answer as the fields it did not get being empty', () => {
    expect(parseSettingsAnswer('0\n', form())).toEqual({
      options: ['This machine', null, null],
      values: [['', ''], [], []],
    });
  });

  // Windows answers -1 for a tab where nothing was picked, which is no option
  // at all rather than the first one.
  it('reads nothing picked as no option', () => {
    expect(parseSettingsAnswer('-1\n', form())).toEqual({
      options: [null, null, null],
      values: [['', ''], [], []],
    });
  });

  it('keeps the spaces around what was typed out of the answer', () => {
    expect(
      parseSettingsAnswer('  8001  \n', {
        cancel: 'Cancel',
        ok: 'Save',
        tabs: [{ fields: [{ label: 'Port', value: '' }], label: 'General' }],
        title: 'CodeBuddy2API',
      }),
    ).toEqual({ options: [null], values: [['8001']] });
  });
});
