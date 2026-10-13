using Fx.Core;
using Fx.Util;
using Xunit;

namespace Fx.Tests;

public class FormatterTests
{
    [Fact]
    public void Formats() => Assert.Equal("5.00 JPY", new Formatter().Format(new Money(5m, "JPY")));
}
