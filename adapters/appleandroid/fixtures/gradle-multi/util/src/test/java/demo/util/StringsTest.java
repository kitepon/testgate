package demo.util;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertEquals;
class StringsTest {
    @Test void shouts() { assertEquals("HI!", Strings.shout("hi")); }
}
