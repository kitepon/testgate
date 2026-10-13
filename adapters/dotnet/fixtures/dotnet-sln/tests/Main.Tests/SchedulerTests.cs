using Fx.Util;
using Xunit;

namespace Fx.Tests;

public class FakeClock : IClock
{
    public DateTime Now => new(2026, 10, 13);
}

public class SchedulerTests
{
    [Fact]
    public void Uses_the_clock() => Assert.Equal(2026, new FakeClock().Now.Year);
}
