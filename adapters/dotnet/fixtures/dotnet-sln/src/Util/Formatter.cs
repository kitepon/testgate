using Fx.Core;

namespace Fx.Util;

public static class MoneyExtensions
{
    public static string Pretty(this Money m) => $"{m.Amount:0.00} {m.Currency}";
}

public class Formatter
{
    public string Format(Money m) => m.Pretty();
}
