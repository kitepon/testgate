using Fx.Core;
using Xunit;

namespace Fx.Tests;

public class MoneyTests
{
    [Fact]
    public void Adds() => Assert.Equal(5m, new Money(2m, "JPY").Add(new Money(3m, "JPY")).Amount);

    [Fact]
    public void Fails_on_purpose_when_enabled()
    {
        if (Environment.GetEnvironmentVariable("FX_FAIL") == "1") Assert.Equal(1, 2);
    }
}
