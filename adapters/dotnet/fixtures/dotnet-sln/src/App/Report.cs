using Fx.Core;
using Fx.Util;

namespace Fx.App;

public class Report
{
    private readonly Formatter _formatter = new();

    public string Line(Money m) => "Total: " + _formatter.Format(m);
}
