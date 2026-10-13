using Fx.App;
using Fx.Core;
using Xunit;

namespace Fx.Tests;

public class ReportTests
{
    [Fact]
    public void Line() => Assert.Equal("Total: 5.00 JPY", new Report().Line(new Money(5m, "JPY")));

    public class Nested
    {
        [Fact]
        public void Still_works() => Assert.StartsWith("Total", new Report().Line(new Money(1m, "JPY")));
    }
}
