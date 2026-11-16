namespace ExamGuard.Agent;

/// <summary>The always-visible tray icon. The candidate can see status and exit at any time.</summary>
public sealed class TrayApp : ApplicationContext
{
    private const string Notice =
        "While paired, this agent records the name of the application in the foreground. "
        + "It does not record keystrokes, screen contents, window titles, or files.";

    private readonly AgentCore core;
    private readonly NotifyIcon icon;
    private readonly ToolStripMenuItem statusItem = new() { Enabled = false };

    public TrayApp(AgentCore core)
    {
        this.core = core;
        var menu = new ContextMenuStrip();
        menu.Items.Add(statusItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Pair with exam session...", null, (_, _) => ShowPairing());
        menu.Items.Add("What is recorded?", null, (_, _) => MessageBox.Show(Notice, "CodeWallah Exam Guard"));
        menu.Items.Add("Exit", null, async (_, _) => await ExitAsync());

        icon = new NotifyIcon
        {
            Icon = SystemIcons.Shield,
            Visible = true,
            ContextMenuStrip = menu,
        };
        icon.DoubleClick += (_, _) => ShowPairing();

        var ui = SynchronizationContext.Current!;
        core.StateChanged += state => ui.Post(_ => Render(state), null);
        core.Resume();
        Render(core.State);
        icon.ShowBalloonTip(8000, "CodeWallah Exam Guard is running", Notice, ToolTipIcon.Info);
    }

    private void Render(AgentState state)
    {
        var text = state switch
        {
            AgentState.Monitoring => "Monitoring active",
            AgentState.Offline => "Monitoring active: server unreachable, events are saved",
            AgentState.Expired => "Session expired: pair again or tell your invigilator",
            _ => "Not monitoring: not paired",
        };
        statusItem.Text = text;

        // NotifyIcon.Text is limited to 127 characters.
        icon.Text = $"Exam Guard: {text}"[..Math.Min(text.Length + 12, 127)];
    }

    private void ShowPairing()
    {
        using var form = new Form
        {
            Text = "Pair with exam session",
            Width = 380,
            Height = 190,
            FormBorderStyle = FormBorderStyle.FixedDialog,
            MaximizeBox = false,
            MinimizeBox = false,
            StartPosition = FormStartPosition.CenterScreen,
        };
        var label = new Label { Text = "Pairing code from the Exam Guard extension:", Left = 15, Top = 15, Width = 340 };
        var input = new TextBox { Left = 15, Top = 42, Width = 335 };
        var status = new Label { Left = 15, Top = 72, Width = 335, ForeColor = Color.Firebrick };
        var pair = new Button { Text = "Pair", Left = 275, Top = 105, Width = 75 };
        form.AcceptButton = pair;
        form.Controls.AddRange([label, input, status, pair]);

        pair.Click += async (_, _) =>
        {
            pair.Enabled = false;
            try
            {
                await core.PairAsync(input.Text, CancellationToken.None);
                form.Close();
            }
            catch (ApiException error)
            {
                status.Text = error.IsUnauthorized ? "That code is invalid or has expired." : error.Message;
                pair.Enabled = true;
            }
        };
        form.ShowDialog();
    }

    private async Task ExitAsync()
    {
        icon.Visible = false;
        await core.StopAsync();
        icon.Dispose();
        ExitThread();
    }
}
