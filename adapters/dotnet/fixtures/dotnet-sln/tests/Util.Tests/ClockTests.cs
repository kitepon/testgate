using Fx.Util;
using Xunit;

namespace Fx.UtilTests;

public class ClockTests
{
    [Fact]
    public void System_clock_is_utc() => Assert.Equal(DateTimeKind.Utc, new SystemClock().Now.Kind);
}
