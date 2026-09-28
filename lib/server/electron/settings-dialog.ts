/**
 * The settings dialog: one dialog of the computer's own, with the computer's
 * own tabs.
 *
 * The menu bar item's Settings used to ask the first-run question again — which
 * backend, which port — because that was the only question the shell had a
 * dialog for. A settings dialog is more than that: the same two things, in a
 * tab of their own, beside a tab that says where this install keeps its data
 * and a tab that says what this app is.
 *
 * The tabs are the desktop's, not a page's: an `NSTabView` inside the alert
 * AppKit draws on macOS, a WinForms `TabControl` on Windows. Each is the
 * control every other dialog on that desktop uses, in the appearance the
 * desktop is in — which is the whole reason the shell asks in the system's
 * dialogs at all. Linux is the exception, because zenity has no tab control to
 * offer: the sections are chosen from a list there, and the chosen one is asked
 * in the dialogs zenity does have.
 *
 * Nothing here runs anything either: what is here is the script each platform is
 * handed and the reading of what it answers back.
 */

import { windowsString, type AskForm } from './ask';

/** One thing a tab asks for. */
export interface SettingsField {
  label: string;
  /** What this field is for, when the tab above it is about something else. */
  message?: string;
  value: string;
}

export interface SettingsTab {
  fields?: SettingsField[];
  label: string;
  /**
   * Rows that open what they name. Drawn as links the desktop itself handles —
   * a click opens the folder or the page, and the dialog stays where it is.
   */
  links?: Array<{ label: string; url: string }>;
  /** What this tab is about, under the tabs. */
  message?: string;
  /** Rows that only say something: what this install is, and where things are. */
  notes?: string[];
  options?: string[];
  /** The option picked to begin with, which is the one on disk. */
  option?: number;
}

export interface SettingsForm {
  cancel: string;
  /** What the last answer could not be used for, at the top of the first tab. */
  error?: string;
  ok: string;
  tabs: SettingsTab[];
  title: string;
}

export interface SettingsAnswer {
  /** The option picked, per tab: null on a tab that offered none. */
  options: Array<string | null>;
  /** What was typed, per tab, in the order that tab's fields were given. */
  values: string[][];
}

/** The width every control is drawn to, and every paragraph wrapped at. */
const WIDTH = 420;

/*
 * macOS: an `NSTabView` inside the alert AppKit draws.
 *
 * It is written in JavaScript — `osascript -l JavaScript` — because a tab view
 * is not a thing AppleScript can name: it is AppKit's, and the ObjC bridge is
 * the way in. The alert is AppKit's too, so the buttons, the appearance and the
 * tab control are the ones every other dialog on this Mac uses.
 */

/** Inside a JavaScript string, JSON's own quoting is exactly right. */
const jsString = (value: string): string => JSON.stringify(value);

/** One control, as the script's layout loop sees it. */
interface Item {
  /** `label`, `input`, `link` or `options`. */
  k: string;
  /** Where the control is put, when the answer has to be read back out of it. */
  name?: string;
  /** The option picked to begin with. */
  selected?: number;
  text?: string;
  titles?: string[];
  url?: string;
  value?: string;
}

interface ScriptTab {
  items: Item[];
  label: string;
  /** What to read back out of this tab, in order. */
  out: Array<{ k: string; r: string }>;
}

const tabItems = (
  tab: SettingsTab,
  names: { next: () => string },
): ScriptTab => {
  const items: Item[] = [];
  const out: Array<{ k: string; r: string }> = [];

  if (tab.message) {
    items.push({ k: 'label', text: tab.message });
  }

  for (const note of tab.notes ?? []) {
    items.push({ k: 'label', text: note });
  }

  for (const link of tab.links ?? []) {
    items.push({ k: 'link', text: link.label, url: link.url });
  }

  if (tab.options?.length) {
    const name = names.next();

    items.push({
      k: 'options',
      name,
      selected: tab.option ?? 0,
      titles: tab.options,
    });
    out.push({ k: 'o', r: name });
  }

  for (const field of tab.fields ?? []) {
    const name = names.next();

    items.push({ k: 'label', text: field.label });

    if (field.message) {
      items.push({ k: 'label', text: field.message });
    }

    items.push({ k: 'input', name, value: field.value });
    out.push({ k: 'f', r: name });
  }

  return { items, label: tab.label, out };
};

export const appleScriptSettings = (form: SettingsForm): string => {
  let count = 0;
  const names = { next: (): string => `r${(count += 1)}` };
  const tabs = form.tabs.map((tab, index) => {
    const script = tabItems(tab, names);

    // The first tab is the one the dialog opens on, so it is the one that says
    // what the last answer could not be used for.
    if (index === 0 && form.error) {
      script.items.unshift({ k: 'label', text: form.error });
    }

    return script;
  });

  return [
    "ObjC.import('Cocoa')",
    // The app lives in the menu bar: a dialog it asks in must not put a Dock
    // icon of its own beside it.
    'var app = $.NSApplication.sharedApplication',
    'app.setActivationPolicy($.NSApplicationActivationPolicyAccessory)',
    `var W = ${WIDTH}`,
    `var TABS = ${JSON.stringify(tabs)}`,
    // A paragraph is wrapped by hand: the height a label is given is the only
    // thing that decides whether the text under it starts below it.
    'var widthOf = function (text) {',
    '  var w = 0',
    '  for (var i = 0; i < text.length; i += 1) {',
    '    w += text.charCodeAt(i) > 0x2e80 ? 1 : 0.55',
    '  }',
    '  return w',
    '}',
    'var linesOf = function (text) { return Math.max(1, Math.ceil(widthOf(text) / (W / 13))) }',
    'var heightOf = function (item) {',
    "  if (item.k === 'label') { return linesOf(item.text) * 17 + 6 }",
    "  if (item.k === 'input') { return 28 }",
    "  if (item.k === 'link') { return 24 }",
    "  if (item.k === 'options') { return item.titles.length * 24 + 8 }",
    '  return 0',
    '}',
    'var refs = {}',
    'var font = $.NSFont.systemFontOfSize($.NSFont.systemFontSize)',
    'var makeLabel = function (text, y, height) {',
    '  var f = $.NSTextField.alloc.initWithFrame($.NSMakeRect(0, y, W, height))',
    '  f.setStringValue(text)',
    '  f.setBezeled(false)',
    '  f.setDrawsBackground(false)',
    '  f.setEditable(false)',
    '  f.setSelectable(true)',
    '  f.setFont(font)',
    '  return f',
    '}',
    'var makeInput = function (value, y) {',
    '  var f = $.NSTextField.alloc.initWithFrame($.NSMakeRect(0, y, W, 22))',
    '  f.setStringValue(value)',
    '  f.setFont(font)',
    '  return f',
    '}',
    // AppKit's own radio group: one control for all the options, so picking one
    // is what unpicks the other — nothing of ours has to keep them in step.
    'var makeOptions = function (item, y) {',
    '  var proto = $.NSButtonCell.alloc.init',
    '  proto.setButtonType($.NSRadioButton)',
    '  var m = $.NSMatrix.alloc.initWithFrameModePrototypeNumberOfRowsNumberOfColumns($.NSMakeRect(0, y, W, item.titles.length * 24), $.NSRadioModeMatrix, proto, item.titles.length, 1)',
    '  var cells = m.cells',
    '  for (var i = 0; i < item.titles.length; i += 1) { cells.objectAtIndex(i).setTitle(item.titles[i]) }',
    '  m.selectCellAtRowColumn(item.selected, 0)',
    '  return m',
    '}',
    // A link, drawn the way the desktop draws one: clicking it opens what it
    // names, and nothing else about the dialog changes.
    'var makeLink = function (item, y) {',
    '  var tv = $.NSTextView.alloc.initWithFrame($.NSMakeRect(0, y, W, 20))',
    '  tv.setEditable(false)',
    '  tv.setSelectable(true)',
    '  tv.setDrawsBackground(false)',
    '  tv.setString(item.text)',
    '  var range = $.NSMakeRange(0, item.text.length)',
    '  tv.textStorage.addAttributeValueRange($.NSLinkAttributeName, $.NSURL.URLWithString(item.url), range)',
    '  tv.textStorage.addAttributeValueRange($.NSForegroundColorAttributeName, $.NSColor.linkColor, range)',
    '  tv.textStorage.addAttributeValueRange($.NSUnderlineStyleAttributeName, $.NSNumber.numberWithInt($.NSUnderlineStyleSingle), range)',
    '  return tv',
    '}',
    'var tabView = $.NSTabView.alloc.initWithFrame($.NSMakeRect(0, 0, W, 240))',
    'var tallest = 240',
    'TABS.forEach(function (tab, index) {',
    '  var total = 16',
    '  tab.items.forEach(function (item) { total += heightOf(item) })',
    '  if (total > tallest) { tallest = total }',
    '  var view = $.NSView.alloc.initWithFrame($.NSMakeRect(0, 0, W, total))',
    '  var y = total - 8',
    '  tab.items.forEach(function (item) {',
    '    var height = heightOf(item)',
    '    y -= height',
    '    var control = null',
    "    if (item.k === 'label') { control = makeLabel(item.text, y + height - linesOf(item.text) * 17, linesOf(item.text) * 17) }",
    "    else if (item.k === 'input') { control = makeInput(item.value, y + 3) }",
    "    else if (item.k === 'link') { control = makeLink(item, y + 2) }",
    "    else if (item.k === 'options') { control = makeOptions(item, y + 4) }",
    '    if (control === null) { return }',
    '    view.addSubview(control)',
    '    if (item.name) { refs[item.name] = control }',
    '  })',
    "  var tabItem = $.NSTabViewItem.alloc.initWithIdentifier('tab' + index)",
    '  tabItem.setLabel(tab.label)',
    '  tabItem.setView(view)',
    '  tabView.addTabViewItem(tabItem)',
    '})',
    'tabView.setFrame($.NSMakeRect(0, 0, W, tallest))',
    'var accessory = $.NSView.alloc.initWithFrame($.NSMakeRect(0, 0, W, tallest))',
    'accessory.addSubview(tabView)',
    'var alert = $.NSAlert.alloc.init',
    `alert.setMessageText(${jsString(form.title)})`,
    `alert.addButtonWithTitle(${jsString(form.ok)})`,
    `alert.addButtonWithTitle(${jsString(form.cancel)})`,
    'alert.setAccessoryView(accessory)',
    // 1000 is the first button, which is the one that saves.
    'if (alert.runModal !== 1000) {',
    "  ''",
    '} else {',
    '  var out = []',
    '  TABS.forEach(function (tab) {',
    '    tab.out.forEach(function (entry) {',
    "      out.push(entry.k === 'o' ? String(refs[entry.r].selectedRow) : ObjC.unwrap(refs[entry.r].stringValue))",
    '    })',
    '  })',
    "  out.join('\\n')",
    '}',
  ].join('\n');
};

/*
 * Windows: a WinForms form with a `TabControl`, which is the framework every
 * dialog Windows draws is written in — the tab control included.
 */

/** The width the form's text wraps at, and the fields are drawn to. */
const WINDOWS_WIDTH = 380;
/** The height the tabs are given: the tallest tab scrolls inside it. */
const WINDOWS_TABS_HEIGHT = 240;

/**
 * What a link hands the shell on Windows: the address itself, unless it is a
 * file the desktop could open — `Start-Process` is given the path, which is what
 * opens the folder in Explorer, rather than a `file://` URL it would not.
 *
 * Read back the way Windows writes a path: `file:///C:/Users/alice` is
 * `C:\Users\alice`, and a share reached as `file://host/share` is
 * `\\host\share`. Cutting the scheme off the front would leave `/C:/Users/alice`,
 * which is no path Windows can open.
 */
const windowsLinkTarget = (url: string): string => {
  if (!url.startsWith('file://')) {
    return url;
  }

  try {
    const { hostname, pathname } = new URL(url);
    const path = decodeURIComponent(pathname)
      .replace(/^\/+/, '')
      .replace(/\//g, '\\');

    return hostname ? `\\\\${hostname}\\${path}` : path;
  } catch {
    // Not a URL naming a file after all: the address is still an address.
    return url;
  }
};

export const windowsSettingsScript = (form: SettingsForm): string => {
  const lines: string[] = [
    'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
    'Add-Type -AssemblyName System.Drawing | Out-Null',
    '[System.Windows.Forms.Application]::EnableVisualStyles()',
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$form = New-Object System.Windows.Forms.Form',
    `$form.Text = ${windowsString(form.title)}`,
    '$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog',
    '$form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen',
    // The app lives in the notification area, and a form it asks in does not
    // put a button of its own in the taskbar.
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
    '$tabs = New-Object System.Windows.Forms.TabControl',
    `$tabs.Size = New-Object System.Drawing.Size(${WINDOWS_WIDTH}, ${WINDOWS_TABS_HEIGHT})`,
    '$tabs.SelectedIndex = 0',
    '$panel.Controls.Add($tabs)',
  ];

  form.tabs.forEach((tab, index) => {
    const flow = `$flow${index}`;

    lines.push(
      `$page${index} = New-Object System.Windows.Forms.TabPage`,
      `$page${index}.Text = ${windowsString(tab.label)}`,
      `$page${index}.Padding = New-Object System.Windows.Forms.Padding(12)`,
      `${flow} = New-Object System.Windows.Forms.FlowLayoutPanel`,
      `${flow}.Dock = [System.Windows.Forms.DockStyle]::Fill`,
      `${flow}.FlowDirection = [System.Windows.Forms.FlowDirection]::TopDown`,
      `${flow}.WrapContents = $false`,
      // A tab with more in it than the height the tabs were given is scrolled,
      // rather than drawn off the bottom of a form that will not grow.
      `${flow}.AutoScroll = $true`,
      `$page${index}.Controls.Add(${flow})`,
      `$tabs.TabPages.Add($page${index})`,
    );

    const addLabel = (text: string): void => {
      const name = `$label${lines.length}`;

      lines.push(
        `${name} = New-Object System.Windows.Forms.Label`,
        `${name}.Text = ${windowsString(text)}`,
        `${name}.AutoSize = $true`,
        `${name}.MaximumSize = New-Object System.Drawing.Size(${WINDOWS_WIDTH - 40}, 0)`,
        `${flow}.Controls.Add(${name})`,
      );
    };

    if (index === 0 && form.error) {
      const name = `$label${lines.length}`;

      lines.push(
        `${name} = New-Object System.Windows.Forms.Label`,
        `${name}.Text = ${windowsString(form.error)}`,
        `${name}.AutoSize = $true`,
        `${name}.MaximumSize = New-Object System.Drawing.Size(${WINDOWS_WIDTH - 40}, 0)`,
        `${name}.ForeColor = [System.Drawing.Color]::Firebrick`,
        `${flow}.Controls.Add(${name})`,
      );
    }

    if (tab.message) {
      addLabel(tab.message);
    }

    for (const note of tab.notes ?? []) {
      addLabel(note);
    }

    for (const link of tab.links ?? []) {
      const name = `$link${lines.length}`;

      lines.push(
        `${name} = New-Object System.Windows.Forms.LinkLabel`,
        `${name}.Text = ${windowsString(link.label)}`,
        `${name}.AutoSize = $true`,
        `${name}.MaximumSize = New-Object System.Drawing.Size(${WINDOWS_WIDTH - 40}, 0)`,
        // The link opens what it names in whatever handles it — a folder in
        // Explorer, a page in the browser — and the form stays open.
        `${name}.Add_LinkClicked({ Start-Process ${windowsString(windowsLinkTarget(link.url))} })`,
        `${flow}.Controls.Add(${name})`,
      );
    }

    (tab.options ?? []).forEach((option, position) => {
      const name = `$option${index}_${position}`;

      lines.push(
        `${name} = New-Object System.Windows.Forms.RadioButton`,
        `${name}.Text = ${windowsString(option)}`,
        `${name}.AutoSize = $true`,
        `${name}.MaximumSize = New-Object System.Drawing.Size(${WINDOWS_WIDTH - 40}, 0)`,
        position === (tab.option ?? 0) ? `${name}.Checked = $true` : '',
        `${flow}.Controls.Add(${name})`,
      );
    });

    // One radio button's being picked is what unpicks the others: a group of
    // them in a flow panel is not one control the way AppKit's is.
    (tab.options ?? []).forEach((_option, position) => {
      const name = `$option${index}_${position}`;

      (tab.options ?? []).forEach((_other, other) => {
        if (other === position) {
          return;
        }

        lines.push(
          `${name}.Add_CheckedChanged({ if (${name}.Checked) { $option${index}_${other}.Checked = $false } })`,
        );
      });
    });

    (tab.fields ?? []).forEach((field, position) => {
      const name = `$field${index}_${position}`;

      addLabel(field.label);

      if (field.message) {
        addLabel(field.message);
      }

      lines.push(
        `${name} = New-Object System.Windows.Forms.TextBox`,
        `${name}.Text = ${windowsString(field.value)}`,
        `${name}.Width = ${WINDOWS_WIDTH - 40}`,
        `${flow}.Controls.Add(${name})`,
      );
    });
  });

  lines.push(
    '$buttons = New-Object System.Windows.Forms.FlowLayoutPanel',
    '$buttons.FlowDirection = [System.Windows.Forms.FlowDirection]::RightToLeft',
    '$buttons.WrapContents = $false',
    '$buttons.AutoSize = $true',
    '$buttons.AutoSizeMode = [System.Windows.Forms.AutoSizeMode]::GrowAndShrink',
    `$buttons.Width = ${WINDOWS_WIDTH}`,
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

  form.tabs.forEach((tab, index) => {
    if (tab.options?.length) {
      lines.push(`$picked${index} = -1`);

      tab.options.forEach((_option, position) => {
        lines.push(
          `if ($option${index}_${position}.Checked) { $picked${index} = ${position} }`,
        );
      });

      lines.push(`Write-Output $picked${index}`);
    }

    (tab.fields ?? []).forEach((_field, position) => {
      lines.push(`Write-Output $field${index}_${position}.Text`);
    });
  });

  return lines.filter(Boolean).join('\n');
};

/*
 * Linux: zenity, which has no tab control to offer.
 *
 * The sections are put in a list instead, and the one picked is asked in the
 * dialogs zenity does have — the same ones the first-run question is asked in.
 */

/** The list of sections, which is what a tab control is on this desktop. */
export const zenitySettingsTabArgs = (form: SettingsForm): string[] => [
  '--list',
  '--title',
  form.title,
  '--text',
  form.title,
  '--hide-header',
  '--column',
  form.title,
  ...form.tabs.map((tab) => tab.label),
];

/** The text a tab that only says things shows. */
export const zenitySettingsNoteArgs = (tab: SettingsTab): string[] => [
  '--info',
  '--title',
  tab.label,
  '--text',
  [...(tab.notes ?? []), ...(tab.links ?? []).map((link) => link.url)].join(
    '\n',
  ),
];

/**
 * One tab as the question the shell already knows how to ask on this desktop:
 * a list to choose from, then an entry per field.
 */
export const settingsTabForm = (
  form: SettingsForm,
  tab: SettingsTab,
): AskForm => ({
  cancel: form.cancel,
  error: form.error,
  fields: tab.fields,
  message: [tab.message, ...(tab.notes ?? [])].filter(Boolean).join('\n\n'),
  ok: form.ok,
  options: tab.options,
  title: form.title,
});

/**
 * What the dialog answered.
 *
 * The lines are the ones the form was built from: the option picked on each tab
 * that offered one, then what was typed in each of that tab's fields. A tab
 * that offered nothing says nothing, and neither does a dialog that was
 * cancelled — which is not an answer.
 */
export const parseSettingsAnswer = (
  stdout: string,
  form: SettingsForm,
): SettingsAnswer | null => {
  const lines = stdout
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .map((line) => line.trim());

  while (lines.length && lines[lines.length - 1] === '') {
    lines.pop();
  }

  if (!lines.length) {
    return null;
  }

  const options: Array<string | null> = [];
  const values: string[][] = [];
  let at = 0;

  for (const tab of form.tabs) {
    const picked = Number.parseInt(lines[at] ?? '', 10);
    const list = tab.options ?? [];

    options.push(
      list.length && Number.isInteger(picked) && picked >= 0
        ? (list[picked] ?? list[0])
        : null,
    );
    at += list.length ? 1 : 0;

    const typed: string[] = [];

    for (const _field of tab.fields ?? []) {
      typed.push(lines[at] ?? '');
      at += 1;
    }

    values.push(typed);
  }

  return { options, values };
};
